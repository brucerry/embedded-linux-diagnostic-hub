// Node-API addon. Its initializer defines exports; no file/token/process/window API is called there.
// Read handles are retained, including on error, cancellation or garbage collection.
// Explicit creation is separate from observation. Neither operation admits a full
// installer lifecycle, proves loaded bytes, or grants window/termination authority.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <winsock2.h>
#include <iphlpapi.h>
#include <ipifcons.h>
#ifdef _MSC_VER
#pragma comment(lib, "iphlpapi.lib")
#endif
#include <bcrypt.h>
#include <node_api.h>
#include <atomic>
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <cstddef>
#include <cwchar>
#include <utility>
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
struct OwnedWindow { uintptr_t handle; DWORD pid; DWORD thread; bool visible; bool minimized; };
constexpr size_t streamLimit = 65536;
struct StreamCapture {
  Lease* reader = nullptr; Lease* writer = nullptr;
  std::array<unsigned char, streamLimit> bytes{}; size_t used = 0;
  bool eof = false, overflow = false, readFailed = false;
};
struct Owner {
  napi_env env; std::wstring root; std::array<File, 2> files;
  std::array<Lease, 64> handles{}; size_t handleSlots = 0; std::vector<std::unique_ptr<Crypto>> crypto;
  // The output slot belongs to the existing owner before GetIfTable2 writes it.
  // A failure output is not authority to inspect or free that pointer.
  PMIB_IF_TABLE2 interfaceTable = nullptr;
  bool interfaceSubmitted = false, interfaceCallReturned = false, interfaceSucceeded = false;
  bool interfaceOutputUnknown = false, interfaceFreeSubmitted = false, interfaceFreeReturned = false;
  std::atomic<bool> busy{false}, cancelled{false};
  void* pendingWork = nullptr;
  bool pins = false, processObserved = false, collected = false, releaseSubmitted = false, released = false;
  std::vector<DWORD> closeErrors;
  const char* failure = nullptr; DWORD systemError = 0; std::exception_ptr primaryException; std::wstring rootGuid, volumeRoot;
  // Borrowed from the existing ancestor leases; never close these aliases twice.
  HANDLE rootParent = nullptr; FILE_ID_INFO rootParentId{}, rootId{}; std::wstring rootParentGuid;
  bool siblingProfileRequested = false, profileIdentityObserved = false;
  Lease* profileLease = nullptr; FILE_ID_INFO profileId{};
  HANDLE process = nullptr; DWORD pid = 0; uint64_t creation = 0; std::vector<Window> windows;
  // Issued with the owner, before any creation call. No cancellation/finalizer
  // may discard outputs, including non-null outputs of an unconfirmed failure.
  PROCESS_INFORMATION launched{};
  Lease* createdProcess = nullptr; Lease* createdThread = nullptr;
  bool launchReserved = false, creationAttempted = false, creationReturned = false, creationSucceeded = false;
  bool profileEmptyObserved = false, createdExitObserved = false; DWORD createdExitCode = 0;
  uint64_t createdTime = 0; std::wstring profileGuid, launchCwd;
  std::vector<wchar_t> launchCommand, launchEnvironment;
  StreamCapture standardOutput, standardError;
  Lease* stdinReader = nullptr; Lease* stdinWriter = nullptr;
  bool pipeAcquisitionUnknown = false, stdioConfigured = false;
  std::vector<std::max_align_t> attributeStorage;
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = nullptr;
  std::array<HANDLE, 3> inheritedStdio{};
  bool attributeInitialized = false, attributeAcquisitionUnknown = false, attributeDeleteSubmitted = false, attributeDeleted = false;
  // A referenced TSFN owns normal event-loop liveness, not the whole host or
  // application. Never reuse its pointer after the once-only release call.
  napi_threadsafe_function hostLifetime = nullptr; napi_ref hostCapRef = nullptr;
  bool hostAcquireSubmitted = false, hostCreateAcknowledged = false, hostReferenceAcknowledged = false;
  bool hostCapRefCreated = false, hostCapRefDeleteSubmitted = false, hostCapRefDeleted = false;
  bool hostHookRegistrationSubmitted = false, hostHookRegistered = false;
  bool hostHookRemovalSubmitted = false, hostHookRemoved = false;
  std::atomic<bool> hostReleaseSubmitted{false}, hostReleaseAcknowledged{false};
  std::atomic<bool> hostFinalizerObserved{false}, hostFinalizerAcknowledged{false}, hostLifetimeUnknown{false};
  std::atomic<bool> hostHookFired{false};
  std::atomic<bool> hostEnvironmentClosing{false};
  size_t releaseClosedCount = 0, releaseTotalCount = 0;
  void check() { if (cancelled.load()) fail("CANCELLED_RETAINED", 0); }
  Lease& slot() { need(handleSlots < handles.size(), "HANDLE_SLOT_LIMIT"); return handles[handleSlots++]; }
  void note(const Fault& f) noexcept { if (!failure) { failure = f.code; systemError = f.system; } }
};
std::mutex ownersMutex;
std::unordered_set<Owner*> owners;
const napi_type_tag ownerTag{0x7d1f6914c3714d2aULL, 0x9dfac285f760821eULL};
// No finalizer/teardown closes a handle or asserts retirement. Unknown handles stay owned.
bool hostLifetimeFinished(const Owner* o) {
  return !o->hostAcquireSubmitted || (o->hostFinalizerAcknowledged && o->hostCapRefDeleted && o->hostHookRemoved && !o->hostLifetimeUnknown);
}
void forgetCollected(Owner* o) noexcept {
  try { if (o->collected && hostLifetimeFinished(o) && !o->interfaceTable && !o->interfaceOutputUnknown && !(o->interfaceFreeSubmitted && !o->interfaceFreeReturned) && (o->released || (o->handleSlots == 0 && o->crypto.empty() && !o->pendingWork)) && !o->busy.load()) {
    std::lock_guard<std::mutex> lock(ownersMutex); owners.erase(o); delete o;
  } } catch (...) { /* Unknown custody is never discarded by GC. */ }
}
void finalize(napi_env, void* data, void*) noexcept { auto* o = static_cast<Owner*>(data); o->collected = true; forgetCollected(o); }
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
HANDLE openPinned(Owner* o, const std::wstring& p, bool directory, bool listDirectory = false, FILE_ID_INFO* capturedId = nullptr) {
  o->check(); auto& lease = o->slot(); lease.handle = CreateFileW(p.c_str(), directory ? (FILE_READ_ATTRIBUTES | (listDirectory ? FILE_LIST_DIRECTORY : 0)) : GENERIC_READ,
    FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : FILE_FLAG_SEQUENTIAL_SCAN), nullptr);
  HANDLE h = lease.handle; if (h == INVALID_HANDLE_VALUE) fail("OPEN_PIN"); lease.acquired = true; o->check(); const auto id = fileId(h, directory); if (capturedId) *capturedId = id; return h;
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
  FILE_ID_INFO previousId{}; HANDLE previous = openPinned(o, p, true, false, &previousId);
  while (at < o->root.size()) { auto end = o->root.find(L'\\', at); if (end == std::wstring::npos) end = o->root.size(); if (p.back() != L'\\') p += L'\\'; p += o->root.substr(at, end - at); FILE_ID_INFO currentId{}; HANDLE h = openPinned(o, p, true, false, &currentId); if (end == o->root.size()) { o->rootGuid = finalPath(h); o->rootId = currentId; o->rootParent = previous; o->rootParentId = previousId; } previous = h; previousId = currentId; at = end + 1; }
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
// This is a bounded observation through the retained directory handle, not proof
// that another actor cannot create files later or that this staging was authorized.
void observeEmptyProfile(Owner* o, HANDLE h) {
  alignas(FILE_ID_BOTH_DIR_INFO) std::array<unsigned char, 65536> buffer{};
  bool first = true; size_t entries = 0;
  for (size_t page = 0; page < 4; ++page) {
    o->check(); buffer.fill(0);
    if (!GetFileInformationByHandleEx(h, first ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo, buffer.data(), DWORD(buffer.size()))) {
      const auto error = GetLastError();
      if (error == ERROR_NO_MORE_FILES) { o->profileEmptyObserved = true; return; }
      fail("PROFILE_ENUMERATION_UNAVAILABLE", error);
    }
    first = false; size_t at = 0;
    for (;;) {
      need(at <= buffer.size() - offsetof(FILE_ID_BOTH_DIR_INFO, FileName), "PROFILE_ENUMERATION_TRUNCATED");
      const auto* row = reinterpret_cast<const FILE_ID_BOTH_DIR_INFO*>(buffer.data() + at);
      const size_t nameBytes = row->FileNameLength, minimum = offsetof(FILE_ID_BOTH_DIR_INFO, FileName) + nameBytes;
      need(nameBytes > 0 && nameBytes % sizeof(wchar_t) == 0 && minimum <= buffer.size() - at, "PROFILE_ENUMERATION_TRUNCATED");
      const std::wstring name(row->FileName, nameBytes / sizeof(wchar_t));
      need((name == L"." || name == L"..") && ++entries <= 2, "PROFILE_NOT_EMPTY");
      if (!row->NextEntryOffset) break;
      need(row->NextEntryOffset >= minimum && row->NextEntryOffset % 8 == 0 && row->NextEntryOffset <= buffer.size() - at, "PROFILE_ENUMERATION_TRUNCATED");
      at += row->NextEntryOffset;
    }
  }
  fail("PROFILE_ENUMERATION_BOUND", 0); // No EOF means no empty observation.
}
bool closeLease(Owner* o, Lease* lease) {
  if (!lease || !lease->acquired) return false;
  if (!lease->closeAttempted) {
    lease->closeAttempted = true;
    if (CloseHandle(lease->handle)) lease->closeAcknowledged = true;
    else { lease->closeError = GetLastError(); o->closeErrors.push_back(lease->closeError); }
  }
  return lease->closeAcknowledged;
}
void pipePair(Owner* o, Lease*& reader, Lease*& writer, bool childReads) {
  o->check();
  reader = &o->slot(); writer = &o->slot();
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  const BOOL ok = CreatePipe(&reader->handle, &writer->handle, &security, 65536);
  const auto error = ok ? 0 : GetLastError();
  // The API documents indeterminate outputs on FALSE, including null outputs.
  // Never infer no acquisition, or close an unconfirmed output by its value.
  if (!ok) { o->pipeAcquisitionUnknown = true; fail("PIPE_ACQUISITION_UNCONFIRMED", error); }
  reader->acquired = reader->handle && reader->handle != INVALID_HANDLE_VALUE;
  writer->acquired = writer->handle && writer->handle != INVALID_HANDLE_VALUE;
  if (!reader->acquired || !writer->acquired) { o->pipeAcquisitionUnknown = true; fail("PIPE_OUTPUT_UNCONFIRMED", 0); }
  HANDLE parent = childReads ? writer->handle : reader->handle;
  if (!SetHandleInformation(parent, HANDLE_FLAG_INHERIT, 0)) fail("PIPE_PARENT_INHERITANCE");
}
void deleteAttributes(Owner* o) {
  need(!o->attributeAcquisitionUnknown, "ATTRIBUTE_ACQUISITION_UNCONFIRMED");
  if (!o->attributeInitialized || o->attributeDeleted) return;
  need(!o->attributeDeleteSubmitted, "ATTRIBUTE_DELETE_UNCONFIRMED");
  o->attributeDeleteSubmitted = true;
  DeleteProcThreadAttributeList(o->attributes); // Void API: only normal return is observed.
  o->attributeDeleted = true;
}
void prepareStdio(Owner* o) {
  need(o->handleSlots + 6 <= o->handles.size(), "HANDLE_SLOT_LIMIT");
  SIZE_T size = 0; SetLastError(0);
  const auto queried = InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
  need(!queried && GetLastError() == ERROR_INSUFFICIENT_BUFFER && size > 0 && size <= 65536, "ATTRIBUTE_SIZE");
  o->attributeStorage.resize((size + sizeof(std::max_align_t) - 1) / sizeof(std::max_align_t));
  o->attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(o->attributeStorage.data());
  if (!InitializeProcThreadAttributeList(o->attributes, 1, 0, &size)) {
    o->attributeAcquisitionUnknown = true; fail("ATTRIBUTE_ACQUISITION_UNCONFIRMED");
  }
  o->attributeInitialized = true;
  pipePair(o, o->stdinReader, o->stdinWriter, true);
  pipePair(o, o->standardOutput.reader, o->standardOutput.writer, false);
  pipePair(o, o->standardError.reader, o->standardError.writer, false);
  need(closeLease(o, o->stdinWriter), "STDIN_EOF_CLOSE_UNCONFIRMED");
  o->inheritedStdio = {o->stdinReader->handle, o->standardOutput.writer->handle, o->standardError.writer->handle};
  if (!UpdateProcThreadAttribute(o->attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      o->inheritedStdio.data(), sizeof(o->inheritedStdio), nullptr, nullptr)) fail("STDIO_HANDLE_LIST");
  o->stdioConfigured = true;
}
bool parentChildCopiesClosed(Owner* o) {
  return o->stdioConfigured && o->stdinReader->closeAcknowledged &&
    o->standardOutput.writer->closeAcknowledged && o->standardError.writer->closeAcknowledged;
}
std::string base64(const unsigned char* bytes, size_t size) {
  static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string result; result.reserve(4 * ((size + 2) / 3));
  for (size_t i = 0; i < size; i += 3) {
    const auto left = size - i; const uint32_t word = uint32_t(bytes[i]) << 16 |
      (left > 1 ? uint32_t(bytes[i + 1]) << 8 : 0) | (left > 2 ? bytes[i + 2] : 0);
    result.push_back(alphabet[(word >> 18) & 63]); result.push_back(alphabet[(word >> 12) & 63]);
    result.push_back(left > 1 ? alphabet[(word >> 6) & 63] : '='); result.push_back(left > 2 ? alphabet[word & 63] : '=');
  }
  return result;
}
void drainStream(Owner* o, StreamCapture& stream) {
  if (stream.eof || !stream.reader) return;
  need(stream.reader->acquired && !stream.reader->closeAttempted && !stream.readFailed, "STDIO_READ_CUSTODY_UNKNOWN");
  std::array<unsigned char, 4096> bytes{}; size_t consumed = 0;
  try {
    // One reader, serial owned Work. This bounds bytes/calls, not synchronous
    // Windows I/O latency; no blocking-pool waiter, timeout, or poller is added.
    for (size_t call = 0; call < 17 && consumed < streamLimit; ++call) {
      DWORD available = 0;
      if (!PeekNamedPipe(stream.reader->handle, nullptr, 0, nullptr, &available, nullptr)) {
        const auto error = GetLastError();
        if (error == ERROR_BROKEN_PIPE) { stream.eof = true; return; }
        fail("STDIO_PEEK_FAILED", error);
      }
      if (!available) return; // No data is not EOF, including after root exit.
      const auto wanted = DWORD((std::min)(size_t(available), (std::min)(bytes.size(), streamLimit - consumed)));
      DWORD got = 0;
      if (!ReadFile(stream.reader->handle, bytes.data(), wanted, &got, nullptr)) {
        const auto error = GetLastError();
        if (error == ERROR_BROKEN_PIPE && got == 0) { stream.eof = true; return; }
        fail("STDIO_READ_FAILED", error);
      }
      need(got <= wanted, "STDIO_READ_RESULT_UNKNOWN");
      if (!got) return; // A successful zero-byte write/read is not writer closure.
      consumed += got;
      const auto keep = (std::min)(size_t(got), streamLimit - stream.used);
      memcpy(stream.bytes.data() + stream.used, bytes.data(), keep); stream.used += keep;
      if (keep != got) stream.overflow = true;
    }
  } catch (...) { stream.readFailed = true; throw; }
}
std::string drainStdio(Owner* o) {
  need(!o->pipeAcquisitionUnknown && !o->attributeAcquisitionUnknown, "STDIO_ACQUISITION_UNCONFIRMED");
  if (o->creationSucceeded) need(parentChildCopiesClosed(o), "STDIO_CHILD_COPY_CLOSE_UNCONFIRMED");
  if (o->stdioConfigured) { drainStream(o, o->standardOutput); drainStream(o, o->standardError); }
  std::ostringstream s;
  s << "{\"configured\":" << (o->stdioConfigured ? "true" : "false")
    << ",\"parentChildCopiesClosed\":" << (parentChildCopiesClosed(o) ? "true" : "false")
    << ",\"acquisitionUnknown\":false";
  for (const auto& item : {std::make_pair("stdout", &o->standardOutput), std::make_pair("stderr", &o->standardError)}) {
    const auto* stream = item.second;
    s << ",\"" << item.first << "\":{\"base64\":\"" << base64(stream->bytes.data(), stream->used)
      << "\",\"eof\":" << (stream->eof ? "true" : "false") << ",\"overflow\":" << (stream->overflow ? "true" : "false") << '}';
  }
  s << '}'; return s.str();
}
void verifySiblingParent(Owner* o) {
  // The requested DOS sibling and the GUID sibling must have the SAME canonical
  // relative spelling. Refuse 8.3 aliases/case rewrites for this new operation.
  need(o->rootGuid.size() > o->volumeRoot.size() && eq(o->rootGuid.substr(0, o->volumeRoot.size()), o->volumeRoot)
    && o->rootGuid.substr(o->volumeRoot.size()) == o->root.substr(3), "SIBLING_ROOT_ALIAS_REFUSED");
  std::array<wchar_t, 64> volume{};
  if (!GetVolumeNameForVolumeMountPointW(o->root.substr(0, 3).c_str(), volume.data(), DWORD(volume.size()))) fail("SIBLING_DRIVE_MAPPING");
  need(eq(volume.data(), o->volumeRoot), "SIBLING_DRIVE_MAPPING_CHANGED");
  need(o->rootParent && sameId(fileId(o->rootParent, true), o->rootParentId), "SIBLING_PARENT_ID_CHANGED");
  const auto parent = finalPath(o->rootParent);
  auto joined = parent; if (joined.back() != L'\\') joined += L'\\'; joined += o->root.substr(o->root.find_last_of(L'\\') + 1);
  need(joined == o->rootGuid, "SIBLING_PARENT_PATH_MISMATCH");
  if (o->rootParentGuid.empty()) o->rootParentGuid = parent;
  need(parent == o->rootParentGuid, "SIBLING_PARENT_PATH_CHANGED");
}
void verifySiblingProfile(Owner* o) {
  verifySiblingParent(o);
  need(o->profileIdentityObserved && o->profileLease && o->profileLease->acquired && !o->profileLease->closeAttempted, "SIBLING_PROFILE_CUSTODY_UNKNOWN");
  need(sameId(fileId(o->profileLease->handle, true), o->profileId), "SIBLING_PROFILE_ID_CHANGED");
  need(finalPath(o->profileLease->handle) == o->profileGuid, "SIBLING_PROFILE_PATH_CHANGED");
  need(o->profileId.VolumeSerialNumber == o->rootId.VolumeSerialNumber && o->profileId.VolumeSerialNumber == o->rootParentId.VolumeSerialNumber, "SIBLING_PROFILE_VOLUME_MISMATCH");
  need(!sameId(o->profileId, o->rootId) && !sameId(o->profileId, o->rootParentId), "SIBLING_PROFILE_ALIAS_REFUSED");
}
void launchPinned(Owner* o, const std::wstring& profile) {
  o->check(); need(o->pins && !o->processObserved, "FILE_PINS_REQUIRED");
  need(o->hostCreateAcknowledged && o->hostReferenceAcknowledged && o->hostHookRegistered && !o->hostReleaseSubmitted && !o->hostEnvironmentClosing.load(), "HOST_LIFETIME_REFERENCE_REQUIRED");
  need(profile == o->root + (o->siblingProfileRequested ? L".native-launch-profile" : L"\\native-launch-profile"), "FIXED_PROFILE_REQUIRED");
  if (o->siblingProfileRequested) verifySiblingParent(o);
  o->profileGuid = o->rootGuid + (o->siblingProfileRequested ? L".native-launch-profile" : L"\\native-launch-profile");
  if (o->siblingProfileRequested) { need(o->handleSlots < o->handles.size(), "HANDLE_SLOT_LIMIT"); o->profileLease = &o->handles[o->handleSlots]; }
  HANDLE profileHandle = openPinned(o, o->profileGuid, true, true);
  need(eq(finalPath(profileHandle), o->profileGuid), "PROFILE_PARENT_MISMATCH");
  if (o->siblingProfileRequested) { o->profileId = fileId(profileHandle, true); o->profileIdentityObserved = true; verifySiblingProfile(o); }
  observeEmptyProfile(o, profileHandle);
  std::array<wchar_t, MAX_PATH + 1> windows{};
  const auto count = GetWindowsDirectoryW(windows.data(), UINT(windows.size()));
  need(count > 0 && count < windows.size(), "WINDOWS_DIRECTORY_UNAVAILABLE");
  const std::wstring windowsDirectory(windows.data(), count); rootSyntax(windowsDirectory);
  need(GetDriveTypeW(windowsDirectory.substr(0, 3).c_str()) == DRIVE_FIXED, "WINDOWS_DIRECTORY_NOT_LOCAL");
  const std::wstring executable = o->rootGuid + L"\\Diagnostic Hub.exe";
  // These are requested launch inputs, not observations of the child environment.
  const std::wstring command = L"\"" + executable + L"\" --inspect=127.0.0.1:0 \"--user-data-dir=" + o->profileGuid + L"\"";
  need(command.size() < 2048 && o->rootGuid.size() < MAX_PATH, "LAUNCH_INPUT_BOUND");
  o->launchCommand.assign(command.begin(), command.end()); o->launchCommand.push_back(0);
  o->launchCwd = o->rootGuid; o->launchEnvironment.clear();
  const std::array<std::pair<const wchar_t*, std::wstring>, 7> environment{{
    {L"APPDATA", o->profileGuid}, {L"LOCALAPPDATA", o->profileGuid}, {L"SystemRoot", windowsDirectory},
    {L"TEMP", o->profileGuid}, {L"TMP", o->profileGuid}, {L"USERPROFILE", o->profileGuid}, {L"WINDIR", windowsDirectory}}};
  for (const auto& pair : environment) {
    o->launchEnvironment.insert(o->launchEnvironment.end(), pair.first, pair.first + wcslen(pair.first));
    o->launchEnvironment.push_back(L'='); o->launchEnvironment.insert(o->launchEnvironment.end(), pair.second.begin(), pair.second.end()); o->launchEnvironment.push_back(0);
  }
  o->launchEnvironment.push_back(0); need(o->launchEnvironment.size() <= 4096, "LAUNCH_ENVIRONMENT_BOUND");
  // Recheck the actual executing worker's token immediately before creation.
  // All buffers and fixed handle slots are owned before the creation effect.
  need(o->handleSlots + 10 <= o->handles.size(), "HANDLE_SLOT_LIMIT"); fitToken(o);
  o->createdProcess = &o->slot(); o->createdThread = &o->slot();
  prepareStdio(o);
  if (o->siblingProfileRequested) verifySiblingProfile(o);
  need(sameId(fileId(o->files[0].handle, false), o->files[0].id) && sameId(fileId(o->files[1].handle, false), o->files[1].id), "PIN_CHANGED_BEFORE_CREATION");
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = o->stdinReader->handle;
  startup.StartupInfo.hStdOutput = o->standardOutput.writer->handle;
  startup.StartupInfo.hStdError = o->standardError.writer->handle;
  startup.lpAttributeList = o->attributes; o->check();
  need(o->hostReferenceAcknowledged && !o->hostEnvironmentClosing.load(), "HOST_LIFETIME_REFERENCE_REQUIRED");
  o->creationAttempted = true;
  const BOOL ok = CreateProcessW(executable.c_str(), o->launchCommand.data(), nullptr, nullptr, TRUE,
    CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, o->launchEnvironment.data(), o->launchCwd.c_str(), &startup.StartupInfo, &o->launched);
  const auto error = ok ? 0 : GetLastError();
  // No allocation/check/cancellation may precede adoption of BOTH outputs.
  o->createdProcess->handle = o->launched.hProcess; o->createdThread->handle = o->launched.hThread;
  o->createdProcess->acquired = ok && o->launched.hProcess && o->launched.hProcess != INVALID_HANDLE_VALUE;
  o->createdThread->acquired = ok && o->launched.hThread && o->launched.hThread != INVALID_HANDLE_VALUE;
  o->creationReturned = true; o->creationSucceeded = ok != FALSE;
  if (!ok) o->note({"CREATE_PROCESS_FAILED_RETAINED", error});
  deleteAttributes(o);
  const bool inputClosed = closeLease(o, o->stdinReader);
  const bool outputClosed = closeLease(o, o->standardOutput.writer);
  const bool errorClosed = closeLease(o, o->standardError.writer);
  need(inputClosed && outputClosed && errorClosed, "STDIO_CHILD_COPY_CLOSE_UNCONFIRMED");
  if (!ok) fail("CREATE_PROCESS_FAILED_RETAINED", error);
  need(o->createdProcess->acquired && o->createdThread->acquired, "CREATION_OUTPUT_UNCONFIRMED");
  o->check(); // A late cancelled success stays retained, not silently closed.
}
std::string ownedFacts(Owner* o) {
  bool retainedProcess = o->createdProcess && o->createdProcess->acquired && !o->createdProcess->closeAttempted;
  bool retainedThread = o->createdThread && o->createdThread->acquired && !o->createdThread->closeAttempted;
  if (o->creationSucceeded) {
    need(retainedProcess && retainedThread, "CREATION_HANDLE_CUSTODY_UNKNOWN");
    need(GetProcessId(o->launched.hProcess) == o->launched.dwProcessId && o->launched.dwProcessId && o->launched.dwThreadId, "CREATED_PROCESS_ID");
    FILETIME creation{}, exit{}, kernel{}, user{};
    if (!GetProcessTimes(o->launched.hProcess, &creation, &exit, &kernel, &user)) fail("CREATED_PROCESS_TIMES");
    const auto time = ticks(creation); need(time > 0 && (!o->createdTime || o->createdTime == time), "CREATED_PROCESS_TIME_CHANGED"); o->createdTime = time;
    const auto status = WaitForSingleObject(o->launched.hProcess, 0);
    need(status == WAIT_OBJECT_0 || status == WAIT_TIMEOUT, "CREATED_PROCESS_WAIT_UNKNOWN");
    if (status == WAIT_OBJECT_0) {
      if (!GetExitCodeProcess(o->launched.hProcess, &o->createdExitCode)) fail("CREATED_EXIT_CODE");
      o->createdExitObserved = true; // 259 is a valid exit code after a signaled wait.
    }
  }
  std::ostringstream s; s << "{\"creationAttempted\":" << (o->creationAttempted ? "true" : "false")
    << ",\"creationReturned\":" << (o->creationReturned ? "true" : "false") << ",\"createdByThisOwner\":" << (o->creationSucceeded ? "true" : "false")
    << ",\"processHandleRetained\":" << (retainedProcess ? "true" : "false") << ",\"threadHandleRetained\":" << (retainedThread ? "true" : "false")
    << ",\"unconfirmedHandleOutput\":" << ((!o->creationSucceeded && (o->launched.hProcess || o->launched.hThread)) ? "true" : "false")
    << ",\"pid\":" << (o->creationSucceeded ? std::to_string(o->launched.dwProcessId) : "null")
    << ",\"threadId\":" << (o->creationSucceeded ? std::to_string(o->launched.dwThreadId) : "null")
    << ",\"creationTime100ns\":" << (o->createdTime ? ("\"" + std::to_string(o->createdTime) + "\"") : "null")
    << ",\"processExitObserved\":" << (o->createdExitObserved ? "true" : "false")
    << ",\"exitCode\":" << (o->createdExitObserved ? std::to_string(o->createdExitCode) : "null")
    << ",\"profileEmptyAtPreflight\":" << (o->profileEmptyObserved ? "true" : "false")
    << ",\"hostEventLoopReferenceAcknowledged\":" << (o->hostReferenceAcknowledged ? "true" : "false")
    << ",\"stdioObserved\":false,\"physicalLoadedBytesVerified\":false,\"physicalDescendantClosure\":false,\"releaseAcceptance\":false";
  if (o->siblingProfileRequested) {
    s << ",\"profileDirectory\":";
    if (!o->profileIdentityObserved) s << "null";
    else s << "{\"volumeSerial\":\"" << hex64(o->profileId.VolumeSerialNumber) << "\",\"fileId\":\"" << hex(o->profileId.FileId.Identifier, 16)
      << "\",\"parentFileId\":\"" << hex(o->rootParentId.FileId.Identifier, 16) << "\",\"emptyAtPreflight\":" << (o->profileEmptyObserved ? "true" : "false")
      << ",\"leaseRetained\":" << (o->profileLease && o->profileLease->acquired && !o->profileLease->closeAttempted ? "true" : "false") << '}';
  }
  s << '}'; return s.str();
}
struct OwnedWindowScan {
  Owner* o; DWORD pid; std::vector<OwnedWindow>* rows;
  bool cancelled = false, overflow = false, changed = false, callbackFailed = false;
};
BOOL CALLBACK enumerateOwned(HWND h, LPARAM raw) noexcept {
  auto* scan = reinterpret_cast<OwnedWindowScan*>(raw);
  try {
    if (scan->o->cancelled.load()) { scan->cancelled = true; return FALSE; }
    DWORD pid = 0; const DWORD thread = GetWindowThreadProcessId(h, &pid);
    if (!h || !thread || !pid) { scan->changed = true; return FALSE; }
    if (pid != scan->pid) return TRUE;
    if (scan->rows->size() >= 128) { scan->overflow = true; return FALSE; }
    const auto handle = reinterpret_cast<uintptr_t>(h);
    for (const auto& row : *scan->rows) if (row.handle == handle) { scan->changed = true; return FALSE; }
    const bool visible = IsWindowVisible(h) != FALSE, minimized = IsIconic(h) != FALSE;
    DWORD afterPid = 0; const DWORD afterThread = GetWindowThreadProcessId(h, &afterPid);
    if (afterPid != pid || afterThread != thread) { scan->changed = true; return FALSE; }
    scan->rows->push_back({handle, pid, thread, visible, minimized});
    return TRUE;
  } catch (...) {
    scan->callbackFailed = true;
    if (!scan->o->primaryException) scan->o->primaryException = std::current_exception();
    scan->o->note({"OWNED_WINDOW_CALLBACK_UNCONFIRMED", 0});
    return FALSE;
  }
}
std::string ownedWindowFacts(Owner* o, std::vector<OwnedWindow>& rows) {
  o->check();
  need(o->creationSucceeded && o->createdTime && o->createdProcess && o->createdThread
    && o->createdProcess->acquired && o->createdThread->acquired
    && !o->createdProcess->closeAttempted && !o->createdThread->closeAttempted, "OWNED_WINDOW_PROCESS_REQUIRED");
  const auto process = o->createdProcess->handle;
  need(process == o->launched.hProcess && GetProcessId(process) == o->launched.dwProcessId, "OWNED_WINDOW_PROCESS_ID");
  need(WaitForSingleObject(process, 0) == WAIT_TIMEOUT, "OWNED_WINDOW_PROCESS_NOT_LIVE");
  FILETIME creation{}, exit{}, kernel{}, user{};
  if (!GetProcessTimes(process, &creation, &exit, &kernel, &user)) fail("OWNED_WINDOW_PROCESS_TIMES");
  need(ticks(creation) == o->createdTime, "OWNED_WINDOW_CREATION_CHANGED");
  need(rows.capacity() >= 128, "OWNED_WINDOW_STORAGE_REQUIRED"); rows.clear();
  OwnedWindowScan scan{o, o->launched.dwProcessId, &rows}; SetLastError(0);
  const BOOL ok = EnumWindows(enumerateOwned, reinterpret_cast<LPARAM>(&scan));
  const DWORD enumerationError = ok ? 0 : GetLastError();
  if (scan.cancelled) fail("CANCELLED_RETAINED", 0);
  if (scan.callbackFailed) { need(bool(o->primaryException), "OWNED_WINDOW_CALLBACK_UNCONFIRMED"); std::rethrow_exception(o->primaryException); }
  need(!scan.overflow && !scan.changed, "OWNED_WINDOW_OBSERVATION_UNCONFIRMED");
  if (!ok) fail("OWNED_WINDOW_ENUMERATION_FAILED", enumerationError);
  o->check();
  need(WaitForSingleObject(process, 0) == WAIT_TIMEOUT && GetProcessId(process) == scan.pid, "OWNED_WINDOW_PROCESS_ENDED");
  if (!GetProcessTimes(process, &creation, &exit, &kernel, &user)) fail("OWNED_WINDOW_PROCESS_TIMES");
  need(ticks(creation) == o->createdTime, "OWNED_WINDOW_CREATION_CHANGED");
  // Bracketed root/window samples do not pin HWNDs, establish interaction, or
  // impose an absolute wall-clock bound on the synchronous user32 call.
  std::ostringstream s; s << "{\"pid\":" << scan.pid << ",\"creationTime100ns\":\"" << o->createdTime
    << "\",\"rootLiveBefore\":true,\"rootLiveAfter\":true,\"windows\":[";
  for (size_t i = 0; i < rows.size(); ++i) { const auto& row = rows[i]; if (i) s << ',';
    s << "{\"handle\":\"" << row.handle << "\",\"pid\":" << row.pid << ",\"threadId\":" << row.thread
      << ",\"visible\":" << (row.visible ? "true" : "false") << ",\"minimized\":" << (row.minimized ? "true" : "false") << '}'; }
  s << "]}"; return s.str();
}
constexpr size_t interfaceRowLimit = 4096;
void freeKnownInterfaceTable(Owner* o) {
  // This is only the documented successful GetIfTable2 allocation, never an
  // error output. A submitted free is never repeated after uncertain return.
  if (!o->interfaceTable || !o->interfaceSucceeded || o->interfaceOutputUnknown || o->interfaceFreeSubmitted) return;
  o->interfaceFreeSubmitted = true;
  FreeMibTable(o->interfaceTable);
  o->interfaceFreeReturned = true; // VOID API: normal call return, not an independent memory probe.
  o->interfaceTable = nullptr;
}
std::string interfaceStatusFacts(Owner* o) {
  o->check();
  need(o->interfaceSubmitted && !o->interfaceCallReturned && !o->interfaceTable, "INTERFACE_OPERATION_NOT_FRESH");
  const auto status = GetIfTable2(&o->interfaceTable);
  o->interfaceCallReturned = true;
  if (status != NO_ERROR) {
    o->interfaceOutputUnknown = true;
    fail("INTERFACE_TABLE_UNCONFIRMED", status); // Do not dereference/free any error output.
  }
  if (!o->interfaceTable) { o->interfaceOutputUnknown = true; fail("INTERFACE_TABLE_MISSING", 0); }
  o->interfaceSucceeded = true; // Adopt known allocated success before cancellation/validation.
  o->check();
  const size_t rows = o->interfaceTable->NumEntries;
  need(rows <= interfaceRowLimit, "INTERFACE_ROW_LIMIT");
  need(rows <= (std::numeric_limits<size_t>::max() - offsetof(MIB_IF_TABLE2, Table)) / sizeof(MIB_IF_ROW2), "INTERFACE_TABLE_SPAN_OVERFLOW");
  const size_t span = offsetof(MIB_IF_TABLE2, Table) + rows * sizeof(MIB_IF_ROW2);
  need(reinterpret_cast<uintptr_t>(o->interfaceTable) <= std::numeric_limits<uintptr_t>::max() - span, "INTERFACE_TABLE_ADDRESS_OVERFLOW");
  std::array<size_t, 8> counts{};
  size_t loopback = 0;
  for (size_t i = 0; i < rows; ++i) {
    o->check();
    // SDK indexing honors MIB_IF_TABLE2/MIB_IF_ROW2 alignment; no packed-byte walk.
    const auto& row = o->interfaceTable->Table[i];
    if (row.Type == IF_TYPE_SOFTWARE_LOOPBACK) ++loopback;
    const auto state = static_cast<unsigned>(row.OperStatus);
    ++counts[state >= 1 && state <= 7 ? state - 1 : 7];
  }
  o->check();
  freeKnownInterfaceTable(o);
  o->check();
  std::ostringstream result;
  result << "{\"scope\":\"collector-interface-snapshot\",\"rowLimit\":" << interfaceRowLimit
    << ",\"rows\":" << rows << ",\"loopbackRows\":" << loopback
    << ",\"upRows\":" << counts[0] << ",\"downRows\":" << counts[1]
    << ",\"testingRows\":" << counts[2] << ",\"unknownRows\":" << counts[3]
    << ",\"dormantRows\":" << counts[4] << ",\"notPresentRows\":" << counts[5]
    << ",\"lowerLayerDownRows\":" << counts[6] << ",\"otherStatusRows\":" << counts[7]
    << ",\"tableFreeReturned\":true,\"allCompartmentsObserved\":false,\"intervalObserved\":false"
    << ",\"machineOffline\":false,\"installerObserved\":false,\"releaseAcceptance\":false}";
  return result.str();
}
void requireCreatedTerminal(Owner* o) {
  need(!o->pipeAcquisitionUnknown && !o->attributeAcquisitionUnknown, "STDIO_ACQUISITION_UNCONFIRMED");
  need(!o->creationAttempted || o->creationReturned, "CREATION_RETURN_UNKNOWN");
  if (o->creationSucceeded) {
    need(o->createdProcess && o->createdProcess->acquired && o->createdThread && o->createdThread->acquired, "CREATION_HANDLE_CUSTODY_UNKNOWN");
    need(WaitForSingleObject(o->launched.hProcess, 0) == WAIT_OBJECT_0, "CREATED_PROCESS_STILL_LIVE_OR_UNKNOWN");
    need(parentChildCopiesClosed(o) && o->standardOutput.eof && o->standardError.eof, "STDIO_EOF_REQUIRED");
    o->createdExitObserved = true;
  } else need(!o->launched.hProcess && !o->launched.hThread, "CREATION_OUTPUT_UNCONFIRMED");
}
// This closes only handles opened by this observer. It never closes a window,
// terminates a process, waits for descendants, or retries an unacknowledged close.
std::string releaseFacts(Owner* o, bool owned) {
  const bool hostComplete = !o->hostAcquireSubmitted || (o->hostReleaseAcknowledged && o->hostFinalizerAcknowledged && !o->hostEnvironmentClosing.load() && !o->hostLifetimeUnknown);
  const bool complete = o->released && (!owned || hostComplete);
  std::ostringstream s; s << "{\"" << (owned ? "ownedHandlesClosed" : "readHandlesClosed") << "\":" << (o->released ? "true" : "false") << ",\"retainedUnknown\":" << (complete ? "false" : "true") << ",\"closedCount\":" << o->releaseClosedCount << ",\"totalCount\":" << o->releaseTotalCount << ",\"processOwnership\":false,\"physicalDescendantClosure\":false,\"releaseAcceptance\":false";
  if (owned) s << ",\"hostLifetimeAcquisitionSubmitted\":" << (o->hostAcquireSubmitted ? "true" : "false")
    << ",\"hostLifetimeReleaseAcknowledged\":" << (o->hostReleaseAcknowledged ? "true" : "false")
    << ",\"hostLifetimeFinalizerObserved\":" << (o->hostFinalizerObserved ? "true" : "false")
    << ",\"hostLifetimeFinalizerAcknowledged\":" << (o->hostFinalizerAcknowledged ? "true" : "false")
    << ",\"hostEnvironmentClosing\":" << (o->hostEnvironmentClosing.load() ? "true" : "false");
  s << '}'; return s.str();
}
std::string releaseHandles(Owner* o, bool owned = false) {
  if (owned) requireCreatedTerminal(o); else need(!o->launchReserved && !o->hostAcquireSubmitted, "OWNED_LAUNCH_RELEASE_REQUIRED");
  deleteAttributes(o);
  freeKnownInterfaceTable(o);
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
  const bool interfaceClosed = !o->interfaceTable && !o->interfaceOutputUnknown && (!o->interfaceFreeSubmitted || o->interfaceFreeReturned);
  o->released = closed == total && cryptoClosed && interfaceClosed;
  o->releaseClosedCount = closed; o->releaseTotalCount = total;
  return releaseFacts(o, owned);
}
enum class Operation { Pin, Observe, ObserveInterfaceStatus, ReleaseRead, Launch, SampleOwned, ObserveOwnedWindows, DrainStdio, ReleaseOwned };
struct Work { Owner* o; napi_env env; napi_async_work work{}; napi_deferred deferred{}; napi_ref cap{}; bool referenceCreated = false, workCreated = false, queueSubmitted = false; Operation operation = Operation::Pin; const char* failure = nullptr; DWORD pid = 0; uint64_t creation = 0; std::wstring profile; std::string result; std::vector<OwnedWindow> ownedWindows; };
void hostCleanupMarker(void* data) noexcept {
  auto* o = static_cast<Owner*>(data); o->hostHookFired.store(true); o->hostEnvironmentClosing.store(true);
  // No close, release, process control, or successful retirement is inferred.
}
void hostNoop(napi_env, napi_value, void*, void*) noexcept { /* No values are queued. */ }
void hostFinalizer(napi_env e, void* data, void*) noexcept {
  auto* o = static_cast<Owner*>(data); o->hostFinalizerObserved.store(true);
  auto* w = static_cast<Work*>(o->pendingWork);
  if (!e || e != o->env || o->hostEnvironmentClosing.load() || o->hostHookFired.load() ||
      !o->hostReleaseSubmitted.load() || !o->hostReleaseAcknowledged.load() || !o->released ||
      !o->hostCapRefDeleted || !o->hostHookRegistered || !w || w->operation != Operation::ReleaseOwned) {
    // A worker can still be running during forced teardown. Only atomic state
    // changes here; never race its first-error bookkeeping or assume live custody.
    o->hostLifetimeUnknown.store(true); return;
  }
  try {
    // This exact registered hook is retained through finalization to distinguish
    // forced environment cleanup. Never blindly remove a fired/unknown hook.
    need(!o->hostHookRemovalSubmitted, "HOST_HOOK_REMOVAL_ALREADY_SUBMITTED");
    o->hostHookRemovalSubmitted = true; api(e, napi_remove_env_cleanup_hook(e, hostCleanupMarker, o));
    o->hostHookRegistered = false; o->hostHookRemoved = true;
    o->hostFinalizerAcknowledged.store(true);
    const auto value = text(e, releaseFacts(o, true));
    api(e, napi_resolve_deferred(e, w->deferred, value));
    o->pendingWork = nullptr; o->busy.store(false); delete w; forgetCollected(o);
  } catch (...) {
    if (!o->primaryException) o->primaryException = std::current_exception();
    o->hostLifetimeUnknown.store(true); o->hostFinalizerAcknowledged.store(false);
    o->note({"HOST_FINALIZER_BOOKKEEPING_UNCONFIRMED", 0});
    // TSFN is closing/already finalized: retained data is not a live-loop keeper.
    // Keep unknown Work/Owner custody; no retry or successful closure settlement.
  }
}
void execute(napi_env, void* raw) {
  auto* w = static_cast<Work*>(raw);
  try {
    switch (w->operation) {
      case Operation::ReleaseRead: w->result = releaseHandles(w->o); break;
      case Operation::ReleaseOwned: w->result = releaseHandles(w->o, true); break;
      case Operation::Observe: process(w->o, w->pid, w->creation); w->result = processFacts(w->o); break;
      case Operation::Launch: launchPinned(w->o, w->profile); w->result = ownedFacts(w->o); break;
      case Operation::SampleOwned: w->result = ownedFacts(w->o); break;
      case Operation::ObserveOwnedWindows: w->result = ownedWindowFacts(w->o, w->ownedWindows); break;
      case Operation::DrainStdio: w->result = drainStdio(w->o); break;
      case Operation::ObserveInterfaceStatus: w->result = interfaceStatusFacts(w->o); break;
      case Operation::Pin: pin(w->o); w->result = fileFacts(w->o); break;
    }
  } catch (const Fault& f) { w->failure = f.code; w->o->note(f); }
  catch (...) { w->failure = "NATIVE_EXCEPTION_RETAINED"; if (!w->o->primaryException) w->o->primaryException = std::current_exception(); w->o->note({w->failure, 0}); }
}
void complete(napi_env e, napi_status status, void* raw) {
  auto* w = static_cast<Work*>(raw);
  try {
    if (status != napi_ok) { w->failure = "ASYNC_COMPLETION_RETAINED"; w->o->note({w->failure, 0}); }
    // This local value remains rooted in the existing completion callback scope
    // after deleting the strong reference, through the final settlement call.
    napi_value localCap; api(e, napi_get_reference_value(e, w->cap, &localCap));
    need(localCap != nullptr, "COMPLETION_CAP_MISSING");
    const bool terminal = w->operation == Operation::SampleOwned || w->operation == Operation::DrainStdio || w->operation == Operation::ReleaseOwned || w->operation == Operation::ReleaseRead;
    const bool resolve = status == napi_ok && !w->failure && !w->result.empty() && (terminal || (!w->o->failure && !w->o->cancelled.load()));
    const bool joinHost = resolve && w->operation == Operation::ReleaseOwned && w->o->released &&
      w->o->hostAcquireSubmitted && w->o->hostCreateAcknowledged && w->o->hostReferenceAcknowledged &&
      w->o->hostHookRegistered && !w->o->hostHookFired.load() && !w->o->hostEnvironmentClosing.load() &&
      !w->o->hostLifetimeUnknown.load() && !w->o->hostFinalizerObserved.load() && !w->o->hostReleaseSubmitted.load();
    napi_value settlement = nullptr;
    if (resolve && !joinHost) settlement = text(e, w->result);
    else if (!resolve) { auto message = text(e, std::string("WINDOWS_NATIVE_") + (w->o->failure ? w->o->failure : "CANCELLED_RETAINED")); api(e, napi_create_error(e, nullptr, message, &settlement)); }
    // A successful release must not escape while async bookkeeping is unknown.
    // Mark only acknowledged deletes, and never repeat them after a later error.
    api(e, napi_delete_async_work(e, w->work));
    w->workCreated = false; w->work = nullptr;
    api(e, napi_delete_reference(e, w->cap));
    w->referenceCreated = false; w->cap = nullptr;
    if (joinHost) {
      auto* o = w->o;
      need(o->hostCapRefCreated && !o->hostCapRefDeleteSubmitted && o->hostCapRef, "HOST_CAP_REFERENCE_UNKNOWN");
      o->hostCapRefDeleteSubmitted = true; api(e, napi_delete_reference(e, o->hostCapRef));
      o->hostCapRefCreated = false; o->hostCapRefDeleted = true; o->hostCapRef = nullptr;
      // localCap roots this scope; the registry/deletion guard retains Owner
      // through later finalization even if the wrapper is subsequently collected.
      const auto lifetime = o->hostLifetime; need(lifetime != nullptr, "HOST_LIFETIME_RESOURCE_UNKNOWN");
      o->hostReleaseSubmitted.store(true); o->hostLifetime = nullptr;
      const auto released = napi_release_threadsafe_function(lifetime, napi_tsfn_release);
      // No ref/unref/query/retry may use lifetime after this call.
      if (released != napi_ok) o->hostLifetimeUnknown.store(true);
      api(e, released); o->hostReleaseAcknowledged.store(true);
      return; // No pool waiter: the finalizer alone can finish this deferred join.
    }
    api(e, resolve ? napi_resolve_deferred(e, w->deferred, settlement) : napi_reject_deferred(e, w->deferred, settlement));
    w->o->pendingWork = nullptr; w->o->busy.store(false); delete w;
  } catch (...) {
    // No C++ exception crosses this callback. Keep work/reference/owner custody
    // and the busy fence when completion bookkeeping was not acknowledged.
    if (!w->o->primaryException) w->o->primaryException = std::current_exception(); if (w->o->hostAcquireSubmitted) w->o->hostLifetimeUnknown.store(true); w->o->note({"NAPI_COMPLETION_RETAINED", 0});
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
napi_value acquireHostLifetime(napi_env e, napi_callback_info info) {
  Owner* o = nullptr;
  try {
    size_t n = 1; napi_value a[1]; api(e, napi_get_cb_info(e, info, &n, a, nullptr, nullptr)); need(n == 1, "HOST_LIFETIME_ARGUMENTS");
    o = owner(e, a[0]);
    need(o->pins && !o->busy.load() && !o->releaseSubmitted && !o->cancelled.load() && !o->failure && !o->processObserved && !o->launchReserved, "HOST_LIFETIME_NOT_ACTIVE");
    need(!o->hostAcquireSubmitted, "HOST_LIFETIME_ALREADY_SUBMITTED"); o->hostAcquireSubmitted = true;
    api(e, napi_create_reference(e, a[0], 1, &o->hostCapRef)); o->hostCapRefCreated = true;
    api(e, napi_create_threadsafe_function(e, nullptr, nullptr, text(e, "windows-created-process-host-lifetime"),
      1, 1, o, hostFinalizer, o, hostNoop, &o->hostLifetime)); o->hostCreateAcknowledged = true;
    api(e, napi_ref_threadsafe_function(e, o->hostLifetime)); o->hostReferenceAcknowledged = true;
    // Node cleanup hooks are LIFO: register this marker AFTER the TSFN's hook.
    o->hostHookRegistrationSubmitted = true; api(e, napi_add_env_cleanup_hook(e, hostCleanupMarker, o)); o->hostHookRegistered = true;
    return text(e, "{\"created\":true,\"referenced\":true,\"cleanupMarkerRegistered\":true}");
  } catch (const Fault& f) {
    if (o && o->hostAcquireSubmitted) { o->hostLifetimeUnknown.store(true); o->note(f); }
    napi_throw_error(e, f.code, f.code); return nullptr;
  } catch (...) {
    if (o && o->hostAcquireSubmitted) { o->hostLifetimeUnknown.store(true); if (!o->primaryException) o->primaryException = std::current_exception(); o->note({"HOST_ACQUISITION_UNCONFIRMED", 0}); }
    napi_throw_error(e, "WINDOWS_NATIVE_HOST_ACQUISITION", "WINDOWS_NATIVE_HOST_ACQUISITION_UNCONFIRMED"); return nullptr;
  }
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
napi_value start(napi_env e, napi_callback_info info, Operation operation) {
  Work* w = nullptr;
  try {
    const bool observe = operation == Operation::Observe, launch = operation == Operation::Launch;
    const bool release = operation == Operation::ReleaseRead || operation == Operation::ReleaseOwned;
    const bool terminal = operation == Operation::SampleOwned || operation == Operation::DrainStdio || operation == Operation::ReleaseOwned;
    size_t n = 3; napi_value a[3]; api(e, napi_get_cb_info(e, info, &n, a, nullptr, nullptr));
    need(n == (observe ? 3u : launch ? 2u : 1u), "OP_ARGUMENTS"); auto* o = owner(e, a[0]);
    need(!o->busy.load() && !o->releaseSubmitted, "CAPABILITY_NOT_ACTIVE");
    if (!terminal && !release) need(!o->failure && !o->cancelled.load() && !o->hostLifetimeUnknown.load(), "CAPABILITY_NOT_ACTIVE");
    if (operation == Operation::ObserveInterfaceStatus) { need(!o->interfaceSubmitted, "INTERFACE_OPERATION_ALREADY_SUBMITTED"); o->interfaceSubmitted = true; }
    if (operation == Operation::Pin) need(!o->pins && !o->launchReserved, "OP_ALREADY_SUBMITTED");
    if (observe) need(o->pins && !o->processObserved && !o->launchReserved, "OP_ALREADY_SUBMITTED");
    if (launch) {
      need(o->pins && !o->processObserved && !o->launchReserved, "OP_ALREADY_SUBMITTED");
      need(o->hostCreateAcknowledged && o->hostReferenceAcknowledged && o->hostHookRegistered && !o->hostReleaseSubmitted.load() && !o->hostEnvironmentClosing.load(), "HOST_LIFETIME_REFERENCE_REQUIRED");
    }
    if (operation == Operation::SampleOwned || operation == Operation::DrainStdio) need(o->pins, "FILE_PINS_REQUIRED");
    if (operation == Operation::ObserveOwnedWindows) need(o->creationSucceeded && o->createdTime && !o->createdExitObserved, "OWNED_WINDOW_PROCESS_REQUIRED");
    if (operation == Operation::ReleaseRead) need(!o->launchReserved && !o->hostAcquireSubmitted, "OWNED_LAUNCH_RELEASE_REQUIRED");
    // Refusal here precedes release submission/invalidation and closes nothing.
    if (operation == Operation::ReleaseOwned) requireCreatedTerminal(o);
    std::wstring profile;
    if (launch) { profile = wide(e, a[1], 260); const bool sibling = profile == o->root + L".native-launch-profile"; need(sibling || profile == o->root + L"\\native-launch-profile", "FIXED_PROFILE_REQUIRED"); o->siblingProfileRequested = sibling; o->launchReserved = true; }
    w = new Work{o, e}; w->operation = operation; w->profile = std::move(profile);
    if (operation == Operation::ObserveOwnedWindows) w->ownedWindows.reserve(128); // Before queueing or any window API.
    if (observe) { double rawPid; api(e, napi_get_value_double(e, a[1], &rawPid)); need(rawPid > 0 && rawPid <= 4294967295.0 && rawPid == uint32_t(rawPid), "PID_INVALID"); w->pid = uint32_t(rawPid); auto s = utf8(e, a[2], 20); need(s[0] != '0' && s.find_first_not_of("0123456789") == std::string::npos, "CREATION_INVALID"); w->creation = 0; for (char digit : s) { auto value = uint64_t(digit - '0'); need(w->creation <= (std::numeric_limits<uint64_t>::max() - value) / 10, "CREATION_OVERFLOW"); w->creation = w->creation * 10 + value; } }
    o->pendingWork = w; o->busy.store(true); if (release) o->releaseSubmitted = true;
    api(e, napi_create_reference(e, a[0], 1, &w->cap)); w->referenceCreated = true;
    api(e, napi_create_async_work(e, nullptr, text(e, "windows-owned-handle-operation"), execute, complete, w, &w->work)); w->workCreated = true;
    napi_value promise; api(e, napi_create_promise(e, &w->deferred, &promise));
    w->queueSubmitted = true;
    const auto queued = napi_queue_async_work(e, w->work);
    if (queued != napi_ok) {
      o->note({"ASYNC_QUEUE_UNCONFIRMED", 0}); napi_value error; api(e, napi_create_error(e, nullptr, text(e, "WINDOWS_NATIVE_ASYNC_QUEUE_UNCONFIRMED"), &error)); api(e, napi_reject_deferred(e, w->deferred, error));
    }
    return promise;
  } catch (const Fault& f) { unqueuedFailure(w, f); napi_throw_error(e, f.code, f.code); return nullptr; }
  catch (...) { unqueuedFailure(w, {"NATIVE_SETUP_EXCEPTION_RETAINED", 0}); napi_throw_error(e, "WINDOWS_NATIVE_EXCEPTION", "WINDOWS_NATIVE_EXCEPTION_RETAINED"); return nullptr; }
}

napi_value pinCall(napi_env e, napi_callback_info i) { return start(e, i, Operation::Pin); }
napi_value processCall(napi_env e, napi_callback_info i) { return start(e, i, Operation::Observe); }
napi_value interfaceStatusCall(napi_env e, napi_callback_info i) { return start(e, i, Operation::ObserveInterfaceStatus); }
napi_value releaseCall(napi_env e, napi_callback_info i) { return start(e, i, Operation::ReleaseRead); }
napi_value launchCall(napi_env e, napi_callback_info i) { return start(e, i, Operation::Launch); }
napi_value sampleOwnedCall(napi_env e, napi_callback_info i) { return start(e, i, Operation::SampleOwned); }
napi_value observeOwnedWindowsCall(napi_env e, napi_callback_info i) { return start(e, i, Operation::ObserveOwnedWindows); }
napi_value drainStdioCall(napi_env e, napi_callback_info i) { return start(e, i, Operation::DrainStdio); }
napi_value releaseOwnedCall(napi_env e, napi_callback_info i) { return start(e, i, Operation::ReleaseOwned); }
napi_value assertCap(napi_env e, napi_callback_info i) { try { size_t n = 1; napi_value a[1]; api(e, napi_get_cb_info(e, i, &n, a, nullptr, nullptr)); need(n == 1, "CAP_ARGUMENT"); auto* o = owner(e, a[0]); need(!o->busy.load() && !o->releaseSubmitted && !o->cancelled.load() && !o->failure && !o->hostLifetimeUnknown.load(), "CAPABILITY_INVALIDATED"); napi_value yes; api(e, napi_get_boolean(e, true, &yes)); return yes; } catch (const Fault& f) { napi_throw_error(e, f.code, f.code); return nullptr; } catch (...) { napi_throw_error(e, "WINDOWS_NATIVE_EXCEPTION", "WINDOWS_NATIVE_EXCEPTION_RETAINED"); return nullptr; } }
napi_value cancel(napi_env e, napi_callback_info i) { try { size_t n = 1; napi_value a[1]; api(e, napi_get_cb_info(e, i, &n, a, nullptr, nullptr)); need(n == 1, "CAP_ARGUMENT"); owner(e, a[0])->cancelled.store(true); napi_value v; napi_get_undefined(e, &v); return v; } catch (const Fault& f) { napi_throw_error(e, f.code, f.code); return nullptr; } catch (...) { napi_throw_error(e, "WINDOWS_NATIVE_EXCEPTION", "WINDOWS_NATIVE_EXCEPTION_RETAINED"); return nullptr; } }
napi_value refuseClose(napi_env e, napi_callback_info) { napi_throw_error(e, "WINDOWS_ATOMIC_NORMAL_CLOSE_UNAVAILABLE", "WINDOWS_ATOMIC_NORMAL_CLOSE_UNAVAILABLE"); return nullptr; }
napi_value init(napi_env e, napi_value exports) {
  napi_property_descriptor props[] = {{"prepare", nullptr, prepare, nullptr, nullptr, nullptr, napi_default, nullptr}, {"assertCapability", nullptr, assertCap, nullptr, nullptr, nullptr, napi_default, nullptr}, {"pinFiles", nullptr, pinCall, nullptr, nullptr, nullptr, napi_default, nullptr}, {"observeProcess", nullptr, processCall, nullptr, nullptr, nullptr, napi_default, nullptr}, {"release", nullptr, releaseCall, nullptr, nullptr, nullptr, napi_default, nullptr}, {"cancel", nullptr, cancel, nullptr, nullptr, nullptr, napi_default, nullptr}, {"refuseNormalClose", nullptr, refuseClose, nullptr, nullptr, nullptr, napi_default, nullptr}, {"acquireLaunchLifetime", nullptr, acquireHostLifetime, nullptr, nullptr, nullptr, napi_default, nullptr}, {"launchPinnedProcess", nullptr, launchCall, nullptr, nullptr, nullptr, napi_default, nullptr}, {"sampleOwnedProcess", nullptr, sampleOwnedCall, nullptr, nullptr, nullptr, napi_default, nullptr}, {"drainOwnedStdio", nullptr, drainStdioCall, nullptr, nullptr, nullptr, napi_default, nullptr}, {"releaseOwnedProcessHandles", nullptr, releaseOwnedCall, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_property_descriptor interfaceStatus = {"observeInterfaceStatus", nullptr, interfaceStatusCall, nullptr, nullptr, nullptr, napi_default, nullptr};
  napi_property_descriptor ownedWindows = {"observeOwnedWindows", nullptr, observeOwnedWindowsCall, nullptr, nullptr, nullptr, napi_default, nullptr};
  if (napi_define_properties(e, exports, sizeof(props) / sizeof(props[0]), props) != napi_ok || napi_define_properties(e, exports, 1, &ownedWindows) != napi_ok || napi_define_properties(e, exports, 1, &interfaceStatus) != napi_ok) { napi_throw_error(e, "WINDOWS_NATIVE_EXPORTS", "WINDOWS_NATIVE_EXPORTS"); return nullptr; } return exports;
}
} // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
