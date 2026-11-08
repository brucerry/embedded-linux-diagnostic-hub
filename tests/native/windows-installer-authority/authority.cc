// Node-API addon. Its initializer defines exports; no file/token/process/window API is called there.
// Read handles are retained, including on error, cancellation or garbage collection.
// This is not a process launcher, installer, loaded-code verifier or close authority.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <bcrypt.h>
#include <node_api.h>
#include <atomic>
#include <array>
#include <cstdint>
#include <cstring>
#include <limits>
#include <exception>
#include <iomanip>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <vector>

namespace {
struct Fault { const char* code; DWORD system; };
[[noreturn]] void fail(const char* code, DWORD system = GetLastError()) { throw Fault{code, system}; }
void need(bool yes, const char* code) { if (!yes) fail(code, 0); }
void nt(NTSTATUS status, const char* code) { if (status != 0) fail(code, static_cast<DWORD>(status)); }
std::string hex(const unsigned char* p, size_t n) {
  std::ostringstream out; out << std::hex << std::setfill('0');
  for (size_t i = 0; i < n; ++i) out << std::setw(2) << static_cast<unsigned>(p[i]);
  return out.str();
}
std::string hex64(uint64_t x) { std::ostringstream out; out << std::hex << std::setfill('0') << std::setw(16) << x; return out.str(); }
uint64_t ticks(FILETIME x) { return (uint64_t(x.dwHighDateTime) << 32) | x.dwLowDateTime; }
bool eq(const std::wstring& a, const std::wstring& b) { return CompareStringOrdinal(a.c_str(), -1, b.c_str(), -1, TRUE) == CSTR_EQUAL; }
struct File { std::wstring relative; uint64_t size; std::string expected; HANDLE handle = INVALID_HANDLE_VALUE; FILE_ID_INFO id{}; std::string digest; };
struct Crypto { BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr; bool hashAcquired = false, providerAcquired = false, hashCloseAttempted = false, providerCloseAttempted = false; std::vector<UCHAR> object; };
struct Lease { HANDLE handle; bool acquired = false; bool closeAttempted = false, closeAcknowledged = false; DWORD closeError = 0; };
struct Window { uintptr_t handle; DWORD pid; DWORD thread; bool visible; };
struct Owner {
  napi_env env; std::wstring root; std::array<File, 2> files;
  std::array<Lease, 64> handles{}; size_t handleSlots = 0; std::vector<std::unique_ptr<Crypto>> crypto;
  std::atomic<bool> busy{false}, cancelled{false};
  void* pendingWork = nullptr;
  bool pins = false, processObserved = false, collected = false, releaseSubmitted = false, released = false;
  std::vector<DWORD> closeErrors;
  const char* failure = nullptr; DWORD systemError = 0; std::exception_ptr primaryException; std::wstring rootGuid, volumeRoot;
  HANDLE process = nullptr; DWORD pid = 0; uint64_t creation = 0; std::vector<Window> windows;
  void check() { if (cancelled.load()) fail("CANCELLED_RETAINED", 0); }
  Lease& slot() { need(handleSlots < handles.size(), "HANDLE_SLOT_LIMIT"); return handles[handleSlots++]; }
  void note(const Fault& f) noexcept { if (!failure) { failure = f.code; systemError = f.system; } }
};
std::mutex ownersMutex;
std::unordered_set<Owner*> owners;
const napi_type_tag ownerTag{0x7d1f6914c3714d2aULL, 0x9dfac285f760821eULL};
// No finalizer/teardown closes a handle or asserts retirement. Unknown handles stay owned.
void finalize(napi_env, void* data, void*) noexcept { auto* o = static_cast<Owner*>(data); o->collected = true; try { if ((o->released || (o->handleSlots == 0 && o->crypto.empty() && !o->pendingWork)) && !o->busy.load()) { std::lock_guard<std::mutex> lock(ownersMutex); owners.erase(o); delete o; } } catch (...) { /* No GC cleanup or exception may discard custody. */ } }
void api(napi_env, napi_status status) { if (status != napi_ok) throw Fault{"NAPI_FAILURE", 0}; }
napi_value text(napi_env e, const std::string& x) { napi_value v; api(e, napi_create_string_utf8(e, x.c_str(), x.size(), &v)); return v; }
std::wstring wide(napi_env e, napi_value v, size_t maximum) {
  napi_valuetype t; api(e, napi_typeof(e, v, &t)); need(t == napi_string, "STRING_REQUIRED");
  size_t n = 0; api(e, napi_get_value_string_utf16(e, v, nullptr, 0, &n)); need(n > 0 && n <= maximum, "STRING_BOUND");
  std::vector<char16_t> s(n + 1); api(e, napi_get_value_string_utf16(e, v, s.data(), s.size(), &n));
  std::wstring r; r.reserve(n); for (size_t i = 0; i < n; ++i) r.push_back(static_cast<wchar_t>(s[i])); need(r.find(L'\0') == std::wstring::npos, "NUL_REFUSED"); return r;
}
napi_value prop(napi_env e, napi_value v, const char* name) { napi_value r; api(e, napi_get_named_property(e, v, name, &r)); return r; }
std::string utf8(napi_env e, napi_value v, size_t maximum) {
  auto w = wide(e, v, maximum); std::string s;
  for (auto c : w) { need(c <= 127, "ASCII_REQUIRED"); s.push_back(static_cast<char>(c)); } return s;
}
Owner* owner(napi_env e, napi_value v) {
  bool tagged = false; api(e, napi_check_object_type_tag(e, v, &ownerTag, &tagged)); need(tagged, "CAPABILITY_UNISSUED");
  void* p = nullptr; api(e, napi_unwrap(e, v, &p)); auto* o = static_cast<Owner*>(p);
  std::lock_guard<std::mutex> lock(ownersMutex); need(owners.count(o) == 1 && o->env == e, "CAPABILITY_UNISSUED"); return o;
}
void rootSyntax(const std::wstring& s) {
  need(s.size() >= 4 && s.size() <= 220 && ((s[0] >= L'A' && s[0] <= L'Z') || (s[0] >= L'a' && s[0] <= L'z')) && s[1] == L':' && s[2] == L'\\' && s.back() != L'\\', "ROOT_INVALID");
  size_t start = 3, depth = 0;
  while (start < s.size()) {
    auto end = s.find(L'\\', start); if (end == std::wstring::npos) end = s.size();
    auto part = s.substr(start, end - start); need(!part.empty() && part != L"." && part != L".." && part.back() != L'.' && part.back() != L' ', "ROOT_COMPONENT_INVALID");
    const auto stem = part.substr(0, part.find(L'.'));
    for (const auto* reserved : {L"CON", L"PRN", L"AUX", L"NUL", L"CONIN$", L"CONOUT$"}) need(!eq(stem, reserved), "ROOT_DEVICE_REFUSED");
    if (stem.size() == 4 && (eq(stem.substr(0, 3), L"COM") || eq(stem.substr(0, 3), L"LPT"))) need(std::wstring(L"123456789\u00b9\u00b2\u00b3").find(stem[3]) == std::wstring::npos, "ROOT_DEVICE_REFUSED");
    for (auto c : part) need(c >= 32 && c != 127 && std::wstring(L"/:*?\"<>|").find(c) == std::wstring::npos, "ROOT_CHARACTER_INVALID");
    need(++depth <= 32, "ROOT_DEPTH"); start = end + 1;
  }
}
std::wstring finalPath(HANDLE h) {
  std::vector<wchar_t> b(1024); DWORD n = GetFinalPathNameByHandleW(h, b.data(), DWORD(b.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
  if (!n || n >= b.size()) fail("FINAL_PATH_UNAVAILABLE"); std::wstring s(b.data(), n);
  need(s.rfind(L"\\\\?\\Volume{", 0) == 0, "LOCAL_VOLUME_REQUIRED"); return s;
}
FILE_ID_INFO fileId(HANDLE h, bool directory) {
  FILE_ATTRIBUTE_TAG_INFO a{}; FILE_ID_INFO id{};
  if (!GetFileInformationByHandleEx(h, FileAttributeTagInfo, &a, sizeof(a))) fail("FILE_ATTRIBUTES");
  need(!(a.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) && bool(a.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory, "REPARSE_OR_TYPE_REFUSED");
  if (!GetFileInformationByHandleEx(h, FileIdInfo, &id, sizeof(id))) fail("FILE_ID");
  if (!directory) { BY_HANDLE_FILE_INFORMATION info{}; if (!GetFileInformationByHandle(h, &info)) fail("FILE_LINK_INFO"); need(info.nNumberOfLinks == 1, "HARD_LINK_REFUSED"); }
  return id;
}
bool sameId(const FILE_ID_INFO& a, const FILE_ID_INFO& b) { return a.VolumeSerialNumber == b.VolumeSerialNumber && memcmp(a.FileId.Identifier, b.FileId.Identifier, 16) == 0; }
HANDLE openPinned(Owner* o, const std::wstring& p, bool directory) {
  o->check(); auto& lease = o->slot(); lease.handle = CreateFileW(p.c_str(), directory ? FILE_READ_ATTRIBUTES : GENERIC_READ,
    FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : FILE_FLAG_SEQUENTIAL_SCAN), nullptr);
  HANDLE h = lease.handle; if (h == INVALID_HANDLE_VALUE) fail("OPEN_PIN"); lease.acquired = true; o->check(); fileId(h, directory); return h;
}
std::vector<BYTE> tokenInfo(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD n = 0; GetTokenInformation(token, kind, nullptr, 0, &n); need(n > 0 && n <= 65536, "TOKEN_BOUND");
  std::vector<BYTE> b(n); if (!GetTokenInformation(token, kind, b.data(), n, &n)) fail("TOKEN_INFO"); return b;
}
void fitToken(Owner* o) {
  auto& threadSlot = o->slot(); BOOL impersonated = OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &threadSlot.handle); if (impersonated) { threadSlot.acquired = true; fail("HOST_IMPERSONATION_UNSUPPORTED", 0); } if (GetLastError() != ERROR_NO_TOKEN) fail("THREAD_TOKEN_QUERY");
  auto& tokenSlot = o->slot(); BOOL ok = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tokenSlot.handle); HANDLE t = tokenSlot.handle; if (!ok) fail("HOST_TOKEN"); tokenSlot.acquired = true;
  auto elevation = tokenInfo(t, TokenElevation), groups = tokenInfo(t, TokenGroups), level = tokenInfo(t, TokenIntegrityLevel), type = tokenInfo(t, TokenElevationType);
  need(!reinterpret_cast<TOKEN_ELEVATION*>(elevation.data())->TokenIsElevated, "HOST_ELEVATED");
  need(*reinterpret_cast<TOKEN_ELEVATION_TYPE*>(type.data()) == TokenElevationTypeDefault, "HOST_SPLIT_TOKEN");
  BYTE admin[SECURITY_MAX_SID_SIZE]; DWORD bytes = sizeof(admin);
  if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, nullptr, admin, &bytes)) fail("ADMIN_SID");
  auto* g = reinterpret_cast<TOKEN_GROUPS*>(groups.data());
  for (DWORD i = 0; i < g->GroupCount; ++i) need(!EqualSid(g->Groups[i].Sid, admin), "HOST_ADMIN_MEMBER");
  auto* sid = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(level.data())->Label.Sid; need(IsValidSid(sid), "HOST_INTEGRITY_SID");
  auto count = *GetSidSubAuthorityCount(sid); need(count > 0 && *GetSidSubAuthority(sid, count - 1) == SECURITY_MANDATORY_MEDIUM_RID, "HOST_INTEGRITY");
}
std::string digest(Owner* o, File& f) {
  auto c = std::make_unique<Crypto>(); Crypto* state = c.get(); o->crypto.push_back(std::move(c));
  nt(BCryptOpenAlgorithmProvider(&state->algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0), "HASH_PROVIDER"); state->providerAcquired = true;
  DWORD n = 0, objectSize = 0; nt(BCryptGetProperty(state->algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectSize), sizeof(objectSize), &n, 0), "HASH_OBJECT"); need(n == sizeof(objectSize) && objectSize > 0 && objectSize <= 65536, "HASH_OBJECT_BOUND");
  state->object.resize(objectSize);
  nt(BCryptCreateHash(state->algorithm, &state->hash, state->object.data(), objectSize, nullptr, 0, 0), "HASH_CREATE"); state->hashAcquired = true;
  std::array<UCHAR, 65536> b{}; uint64_t count = 0;
  for (;;) { o->check(); DWORD got = 0; if (!ReadFile(f.handle, b.data(), DWORD(b.size()), &got, nullptr)) fail("FILE_READ"); if (!got) break; count += got; need(count <= f.size, "FILE_GROWTH"); nt(BCryptHashData(state->hash, b.data(), got, 0), "HASH_DATA"); }
  need(count == f.size, "FILE_SIZE"); std::array<UCHAR, 32> out{}; nt(BCryptFinishHash(state->hash, out.data(), DWORD(out.size()), 0), "HASH_FINISH");
  // Failed crypto closure is retained; never silently discard or retry a handle.
  state->hashCloseAttempted = true; nt(BCryptDestroyHash(state->hash), "HASH_CLOSE_UNCONFIRMED"); state->hash = nullptr;
  state->providerCloseAttempted = true; nt(BCryptCloseAlgorithmProvider(state->algorithm, 0), "HASH_PROVIDER_CLOSE_UNCONFIRMED"); state->algorithm = nullptr;
  return hex(out.data(), out.size());
}
void pin(Owner* o) {
  o->check(); fitToken(o);
  const auto drive = o->root.substr(0, 3); need(GetDriveTypeW(drive.c_str()) == DRIVE_FIXED, "LOCAL_FIXED_VOLUME_REQUIRED");
  std::array<wchar_t, 64> volume{}; if (!GetVolumeNameForVolumeMountPointW(drive.c_str(), volume.data(), DWORD(volume.size()))) fail("LOCAL_VOLUME_GUID");
  o->volumeRoot = volume.data(); need(o->volumeRoot.rfind(L"\\\\?\\Volume{", 0) == 0 && o->volumeRoot.back() == L'\\', "LOCAL_VOLUME_GUID");
  // Subsequent opens use the resolved local volume GUID, not a mutable DOS drive alias.
  std::wstring p = o->volumeRoot; size_t at = 3;
  openPinned(o, p, true);
  while (at < o->root.size()) { auto end = o->root.find(L'\\', at); if (end == std::wstring::npos) end = o->root.size(); if (p.back() != L'\\') p += L'\\'; p += o->root.substr(at, end - at); HANDLE h = openPinned(o, p, true); if (end == o->root.size()) o->rootGuid = finalPath(h); at = end + 1; }
  auto resources = openPinned(o, o->rootGuid + L"\\resources", true); need(eq(finalPath(resources), o->rootGuid + L"\\resources"), "RESOURCE_PARENT_MISMATCH");
  for (auto& f : o->files) {
    auto relative = f.relative; for (auto& c : relative) if (c == L'/') c = L'\\';
    f.handle = openPinned(o, o->rootGuid + L"\\" + relative, false); f.id = fileId(f.handle, false);
    need(eq(finalPath(f.handle), o->rootGuid + L"\\" + relative), "FILE_PARENT_MISMATCH");
    LARGE_INTEGER size{}; if (!GetFileSizeEx(f.handle, &size)) fail("FILE_SIZE_QUERY"); need(size.QuadPart >= 0 && uint64_t(size.QuadPart) == f.size, "FILE_SIZE");
    f.digest = digest(o, f); need(f.digest == f.expected, "FILE_DIGEST");
    need(sameId(f.id, fileId(f.handle, false)), "FILE_ID_CHANGED");
  }
  o->check(); o->pins = true;
}
struct WindowScan { Owner* o; bool overflow = false, cancelled = false; };
BOOL CALLBACK enumerate(HWND h, LPARAM raw) {
  auto* scan = reinterpret_cast<WindowScan*>(raw); if (scan->o->cancelled.load()) { scan->cancelled = true; return FALSE; } DWORD pid = 0; DWORD tid = GetWindowThreadProcessId(h, &pid);
  if (pid != scan->o->pid) return TRUE;
  if (!tid || scan->o->windows.size() >= 128) { scan->overflow = true; return FALSE; }
  scan->o->windows.push_back({reinterpret_cast<uintptr_t>(h), pid, tid, IsWindowVisible(h) != FALSE}); return TRUE;
}
void process(Owner* o, DWORD pid, uint64_t expected) {
  o->check(); need(o->pins, "FILE_PINS_REQUIRED");
  auto& lease = o->slot(); lease.handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid); HANDLE h = lease.handle; o->process = h; if (!h) fail("PROCESS_OPEN"); lease.acquired = true;
  need(GetProcessId(h) == pid && WaitForSingleObject(h, 0) == WAIT_TIMEOUT, "PROCESS_NOT_LIVE");
  FILETIME creation{}, exit{}, kernel{}, user{}; if (!GetProcessTimes(h, &creation, &exit, &kernel, &user)) fail("PROCESS_TIMES");
  o->pid = pid; o->creation = ticks(creation); need(o->creation == expected, "PROCESS_CREATION_MISMATCH");
  std::vector<wchar_t> name(1024); DWORD length = DWORD(name.size()); if (!QueryFullProcessImageNameW(h, 0, name.data(), &length)) fail("PROCESS_IMAGE_NAME");
  const std::wstring reported(name.data(), length);
  need(eq(reported, o->root + L"\\Diagnostic Hub.exe") || eq(reported, o->rootGuid + L"\\Diagnostic Hub.exe"), "PROCESS_REPORTED_PATH_MISMATCH");
  std::array<wchar_t, 64> volume{}; if (!GetVolumeNameForVolumeMountPointW(o->root.substr(0, 3).c_str(), volume.data(), DWORD(volume.size()))) fail("PROCESS_DRIVE_MAPPING");
  need(eq(volume.data(), o->volumeRoot), "PROCESS_DRIVE_MAPPING_CHANGED");
  HANDLE current = openPinned(o, o->rootGuid + L"\\Diagnostic Hub.exe", false);
  // This compares the CURRENT named image file, not the originally loaded image section.
  need(sameId(fileId(current, false), o->files[0].id) && eq(finalPath(current), finalPath(o->files[0].handle)), "CURRENT_IMAGE_FILE_MISMATCH");
  WindowScan scan{o}; SetLastError(0); BOOL ok = EnumWindows(enumerate, reinterpret_cast<LPARAM>(&scan)); if (scan.cancelled) fail("CANCELLED_RETAINED", 0); if (!ok || scan.overflow) fail("WINDOW_OBSERVATION", GetLastError());
  need(WaitForSingleObject(h, 0) == WAIT_TIMEOUT, "PROCESS_ENDED_DURING_OBSERVATION"); o->check(); o->processObserved = true;
}
std::string fileFacts(Owner* o) {
  need(o->pins, "FILE_PINS_REQUIRED"); std::ostringstream s; s << "{\"host\":{\"adminMember\":false,\"elevated\":false,\"integrityRid\":8192},\"files\":[";
  for (size_t i = 0; i < 2; ++i) { if (i) s << ','; auto& f = o->files[i]; s << "{\"relativePath\":\"" << (i ? "resources/app.asar" : "Diagnostic Hub.exe") << "\",\"size\":" << f.size << ",\"sha256\":\"" << f.digest << "\",\"fileId\":\"" << hex(f.id.FileId.Identifier, 16) << "\",\"volumeSerial\":\"" << hex64(f.id.VolumeSerialNumber) << "\"}"; }
  s << "],\"leaseScope\":\"named-executable-and-asar\",\"fileLeasesRetained\":true,\"physicalLoadedBytesVerified\":false,\"releaseAcceptance\":false}"; return s.str();
}
std::string processFacts(Owner* o) {
  need(o->processObserved, "PROCESS_OBSERVATION_REQUIRED"); std::ostringstream s; s << "{\"pid\":" << o->pid << ",\"creationTime100ns\":\"" << o->creation << "\",\"imagePathMatchesPinnedName\":true,\"openedImagePathFileIdMatchesPin\":true,\"processHandleRetained\":true,\"windows\":[";
  for (size_t i = 0; i < o->windows.size(); ++i) { if (i) s << ','; auto w = o->windows[i]; s << "{\"handle\":\"" << w.handle << "\",\"pid\":" << w.pid << ",\"threadId\":" << w.thread << ",\"visible\":" << (w.visible ? "true" : "false") << '}'; }
  s << "],\"processOwnership\":false,\"physicalLoadedBytesVerified\":false,\"physicalDescendantClosure\":false,\"releaseAcceptance\":false}"; return s.str();
}
// This closes only handles opened by this observer. It never closes a window,
// terminates a process, waits for descendants, or retries an unacknowledged close.
std::string releaseHandles(Owner* o) {
  for (auto& state : o->crypto) {
    if (state->hash && state->hashAcquired && !state->hashCloseAttempted) { state->hashCloseAttempted = true; auto status = BCryptDestroyHash(state->hash); if (status == 0) state->hash = nullptr; else o->closeErrors.push_back(static_cast<DWORD>(status)); }
    if (!state->hash && state->algorithm && state->providerAcquired && !state->providerCloseAttempted) { state->providerCloseAttempted = true; auto status = BCryptCloseAlgorithmProvider(state->algorithm, 0); if (status == 0) state->algorithm = nullptr; else o->closeErrors.push_back(static_cast<DWORD>(status)); }
  }
  size_t closed = 0, total = 0;
  for (size_t i = o->handleSlots; i > 0; --i) {
    auto* it = &o->handles[i - 1];
    if (!it->handle || it->handle == INVALID_HANDLE_VALUE) continue;
    ++total;
    if (!it->acquired) continue; // A non-null failure output is not permission to close it.
    if (!it->closeAttempted) { it->closeAttempted = true; if (CloseHandle(it->handle)) it->closeAcknowledged = true; else { it->closeError = GetLastError(); o->closeErrors.push_back(it->closeError); } }
    if (it->closeAcknowledged) ++closed;
  }
  bool cryptoClosed = true; for (auto& state : o->crypto) cryptoClosed = cryptoClosed && !state->hash && !state->algorithm;
  o->released = closed == total && cryptoClosed;
  std::ostringstream s; s << "{\"readHandlesClosed\":" << (o->released ? "true" : "false") << ",\"retainedUnknown\":" << (o->released ? "false" : "true") << ",\"closedCount\":" << closed << ",\"totalCount\":" << total << ",\"processOwnership\":false,\"physicalDescendantClosure\":false,\"releaseAcceptance\":false}"; return s.str();
}
struct Work { Owner* o; napi_env env; napi_async_work work{}; napi_deferred deferred{}; napi_ref cap{}; bool referenceCreated = false, workCreated = false, queueSubmitted = false; bool isProcess; bool isRelease = false; DWORD pid; uint64_t creation; std::string result; };
void execute(napi_env, void* raw) { auto* w = static_cast<Work*>(raw); try { if (w->isRelease) w->result = releaseHandles(w->o); else if (w->isProcess) { process(w->o, w->pid, w->creation); w->result = processFacts(w->o); } else { pin(w->o); w->result = fileFacts(w->o); } } catch (const Fault& f) { w->o->note(f); } catch (...) { if (!w->o->primaryException) w->o->primaryException = std::current_exception(); w->o->note({"NATIVE_EXCEPTION_RETAINED", 0}); } }
void complete(napi_env e, napi_status status, void* raw) {
  auto* w = static_cast<Work*>(raw);
  try {
    if (status != napi_ok) w->o->note({"ASYNC_COMPLETION_RETAINED", 0});
    // This local value remains rooted in the existing completion callback scope
    // after deleting the strong reference, through the final settlement call.
    napi_value localCap; api(e, napi_get_reference_value(e, w->cap, &localCap));
    need(localCap != nullptr, "COMPLETION_CAP_MISSING");
    const bool resolve = status == napi_ok && !w->result.empty() && (w->isRelease || (!w->o->failure && !w->o->cancelled.load()));
    napi_value settlement;
    if (resolve) settlement = text(e, w->result);
    else { auto message = text(e, std::string("WINDOWS_NATIVE_") + (w->o->failure ? w->o->failure : "CANCELLED_RETAINED")); api(e, napi_create_error(e, nullptr, message, &settlement)); }
    // A successful release must not escape while async bookkeeping is unknown.
    // Mark only acknowledged deletes, and never repeat them after a later error.
    api(e, napi_delete_async_work(e, w->work));
    w->workCreated = false; w->work = nullptr;
    api(e, napi_delete_reference(e, w->cap));
    w->referenceCreated = false; w->cap = nullptr;
    api(e, resolve ? napi_resolve_deferred(e, w->deferred, settlement) : napi_reject_deferred(e, w->deferred, settlement));
    w->o->pendingWork = nullptr; w->o->busy.store(false); delete w;
  } catch (...) {
    // No C++ exception crosses this callback. Keep work/reference/owner custody
    // and the busy fence when completion bookkeeping was not acknowledged.
    if (!w->o->primaryException) w->o->primaryException = std::current_exception(); w->o->note({"NAPI_COMPLETION_RETAINED", 0});
  }
}

napi_value prepare(napi_env e, napi_callback_info info) {
  try { size_t n = 1; napi_value a[1]; api(e, napi_get_cb_info(e, info, &n, a, nullptr, nullptr)); need(n == 1, "PREPARE_ARGUMENTS");
    Owner* o = nullptr; { std::lock_guard<std::mutex> lock(ownersMutex); need(owners.size() < 32, "OWNER_LIMIT"); auto provisional = std::make_unique<Owner>(); provisional->env = e; owners.insert(provisional.get()); o = provisional.release(); }
    napi_value cap; api(e, napi_create_object(e, &cap)); api(e, napi_wrap(e, cap, o, finalize, nullptr, nullptr)); api(e, napi_type_tag_object(e, cap, &ownerTag)); api(e, napi_object_freeze(e, cap)); // Issued before any Windows effect.
    o->windows.reserve(128); o->closeErrors.reserve(68); o->crypto.reserve(2);
    o->root = wide(e, prop(e, a[0], "root"), 220); rootSyntax(o->root);
    auto files = prop(e, a[0], "expectedFiles"); bool array = false; api(e, napi_is_array(e, files, &array)); uint32_t count = 0; api(e, napi_get_array_length(e, files, &count)); need(array && count == 2, "TWO_CRITICAL_FILES_REQUIRED");
    for (uint32_t i = 0; i < 2; ++i) { napi_value f; api(e, napi_get_element(e, files, i, &f)); auto& target = o->files[i]; target.relative = wide(e, prop(e, f, "relativePath"), 64); need(target.relative == (i ? L"resources/app.asar" : L"Diagnostic Hub.exe"), "FIXED_FILE_REQUIRED"); double size; api(e, napi_get_value_double(e, prop(e, f, "size"), &size)); need(size > 0 && size <= 536870912 && size == uint64_t(size), "FILE_SIZE_BOUND"); target.size = uint64_t(size); target.expected = utf8(e, prop(e, f, "sha256"), 64); need(target.expected.size() == 64 && target.expected.find_first_not_of("0123456789abcdef") == std::string::npos, "DIGEST_INVALID"); }
    return cap;
  } catch (const Fault& f) { napi_throw_error(e, f.code, f.code); return nullptr; } catch (...) { napi_throw_error(e, "WINDOWS_NATIVE_EXCEPTION", "WINDOWS_NATIVE_EXCEPTION_RETAINED"); return nullptr; }
}
// Known, unqueued bookkeeping can be released. A failed delete remains retained.
void unqueuedFailure(Work* w, const Fault& original) noexcept {
  if (!w) return; w->o->note(original);
  if (w->queueSubmitted) return;
  bool acknowledged = true;
  if ((w->cap && !w->referenceCreated) || (w->work && !w->workCreated)) acknowledged = false;
  if (w->workCreated && napi_delete_async_work(w->env, w->work) != napi_ok) acknowledged = false;
  if (w->referenceCreated && napi_delete_reference(w->env, w->cap) != napi_ok) acknowledged = false;
  if (acknowledged) { w->o->pendingWork = nullptr; w->o->busy.store(false); delete w; }
}
napi_value start(napi_env e, napi_callback_info info, bool isProcess, bool isRelease = false) {
  Work* w = nullptr;
  try { size_t n = 3; napi_value a[3]; api(e, napi_get_cb_info(e, info, &n, a, nullptr, nullptr)); need(n == (isProcess ? 3u : 1u), "OP_ARGUMENTS"); auto* o = owner(e, a[0]); need(!o->busy.load() && !o->releaseSubmitted, "CAPABILITY_NOT_ACTIVE"); if (!isRelease) { need(!o->failure && !o->cancelled.load(), "CAPABILITY_NOT_ACTIVE"); need(isProcess ? (o->pins && !o->processObserved) : !o->pins, "OP_ALREADY_SUBMITTED"); }
    w = new Work{o, e}; w->isProcess = isProcess; w->isRelease = isRelease;
    if (isProcess) { double rawPid; api(e, napi_get_value_double(e, a[1], &rawPid)); need(rawPid > 0 && rawPid <= 4294967295.0 && rawPid == uint32_t(rawPid), "PID_INVALID"); w->pid = uint32_t(rawPid); auto s = utf8(e, a[2], 20); need(s[0] != '0' && s.find_first_not_of("0123456789") == std::string::npos, "CREATION_INVALID"); w->creation = 0; for (char digit : s) { auto value = uint64_t(digit - '0'); need(w->creation <= (std::numeric_limits<uint64_t>::max() - value) / 10, "CREATION_OVERFLOW"); w->creation = w->creation * 10 + value; } }
    o->pendingWork = w; o->busy.store(true); if (isRelease) o->releaseSubmitted = true;
    api(e, napi_create_reference(e, a[0], 1, &w->cap)); w->referenceCreated = true;
    api(e, napi_create_async_work(e, nullptr, text(e, "windows-read-handle-observation"), execute, complete, w, &w->work)); w->workCreated = true;
    napi_value promise; api(e, napi_create_promise(e, &w->deferred, &promise));
    w->queueSubmitted = true;
    const auto queued = napi_queue_async_work(e, w->work);
    if (queued != napi_ok) {
      // Retain the work/reference and fence the owner: no queue outcome is invented.
      o->note({"ASYNC_QUEUE_UNCONFIRMED", 0}); napi_value error; api(e, napi_create_error(e, nullptr, text(e, "WINDOWS_NATIVE_ASYNC_QUEUE_UNCONFIRMED"), &error)); api(e, napi_reject_deferred(e, w->deferred, error));
    }
    return promise;
  } catch (const Fault& f) { unqueuedFailure(w, f); napi_throw_error(e, f.code, f.code); return nullptr; }
  catch (...) { unqueuedFailure(w, {"NATIVE_SETUP_EXCEPTION_RETAINED", 0}); napi_throw_error(e, "WINDOWS_NATIVE_EXCEPTION", "WINDOWS_NATIVE_EXCEPTION_RETAINED"); return nullptr; }
}

napi_value pinCall(napi_env e, napi_callback_info i) { return start(e, i, false); }
napi_value processCall(napi_env e, napi_callback_info i) { return start(e, i, true); }
napi_value releaseCall(napi_env e, napi_callback_info i) { return start(e, i, false, true); }
napi_value assertCap(napi_env e, napi_callback_info i) { try { size_t n = 1; napi_value a[1]; api(e, napi_get_cb_info(e, i, &n, a, nullptr, nullptr)); need(n == 1, "CAP_ARGUMENT"); auto* o = owner(e, a[0]); need(!o->busy.load() && !o->releaseSubmitted && !o->cancelled.load() && !o->failure, "CAPABILITY_INVALIDATED"); napi_value yes; api(e, napi_get_boolean(e, true, &yes)); return yes; } catch (const Fault& f) { napi_throw_error(e, f.code, f.code); return nullptr; } catch (...) { napi_throw_error(e, "WINDOWS_NATIVE_EXCEPTION", "WINDOWS_NATIVE_EXCEPTION_RETAINED"); return nullptr; } }
napi_value cancel(napi_env e, napi_callback_info i) { try { size_t n = 1; napi_value a[1]; api(e, napi_get_cb_info(e, i, &n, a, nullptr, nullptr)); need(n == 1, "CAP_ARGUMENT"); owner(e, a[0])->cancelled.store(true); napi_value v; napi_get_undefined(e, &v); return v; } catch (const Fault& f) { napi_throw_error(e, f.code, f.code); return nullptr; } catch (...) { napi_throw_error(e, "WINDOWS_NATIVE_EXCEPTION", "WINDOWS_NATIVE_EXCEPTION_RETAINED"); return nullptr; } }
napi_value refuseClose(napi_env e, napi_callback_info) { napi_throw_error(e, "WINDOWS_ATOMIC_NORMAL_CLOSE_UNAVAILABLE", "WINDOWS_ATOMIC_NORMAL_CLOSE_UNAVAILABLE"); return nullptr; }
napi_value init(napi_env e, napi_value exports) {
  napi_property_descriptor props[] = {{"prepare", nullptr, prepare, nullptr, nullptr, nullptr, napi_default, nullptr}, {"assertCapability", nullptr, assertCap, nullptr, nullptr, nullptr, napi_default, nullptr}, {"pinFiles", nullptr, pinCall, nullptr, nullptr, nullptr, napi_default, nullptr}, {"observeProcess", nullptr, processCall, nullptr, nullptr, nullptr, napi_default, nullptr}, {"release", nullptr, releaseCall, nullptr, nullptr, nullptr, napi_default, nullptr}, {"cancel", nullptr, cancel, nullptr, nullptr, nullptr, napi_default, nullptr}, {"refuseNormalClose", nullptr, refuseClose, nullptr, nullptr, nullptr, napi_default, nullptr}};
  if (napi_define_properties(e, exports, sizeof(props) / sizeof(props[0]), props) != napi_ok) { napi_throw_error(e, "WINDOWS_NATIVE_EXPORTS", "WINDOWS_NATIVE_EXPORTS"); return nullptr; } return exports;
}
} // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
