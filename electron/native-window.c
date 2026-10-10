#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>

// Keep Chromium's procedure on the Windows stack, with no JS/FFI callbacks.
typedef struct HubWindow {
    BOOL enabled;
    BOOL bypass;
    BOOL queued;
    UINT notification;
} HubWindow;

static LRESULT CALLBACK HubProcedure(HWND window, UINT message, WPARAM wparam,
        LPARAM lparam, UINT_PTR id, DWORD_PTR data) {
    HubWindow *state = (HubWindow *)data;
    if (message == WM_NCDESTROY) {
        RemoveWindowSubclass(window, HubProcedure, id);
        HeapFree(GetProcessHeap(), 0, state);
        return DefSubclassProc(window, message, wparam, lparam);
    }
    if (message == state->notification) state->queued = FALSE;
    if (message == WM_SYSCOMMAND && (wparam & 0xfff0) == SC_MINIMIZE &&
            state->enabled && !state->bypass && !IsIconic(window)) {
        if (!state->queued) {
            state->queued = TRUE;
            if (!PostMessageW(window, state->notification, 0, 0)) {
                state->queued = FALSE;
                return DefSubclassProc(window, message, wparam, lparam);
            }
        }
        return 0;
    }
    return DefSubclassProc(window, message, wparam, lparam);
}

static HubWindow *HubState(HWND window) {
    DWORD_PTR data = 0;
    if (!GetWindowSubclass(window, HubProcedure, 1, &data)) return NULL;
    return (HubWindow *)data;
}

__declspec(dllexport) UINT __stdcall HubAttach(HWND window) {
    DWORD process = 0;
    DWORD thread = GetWindowThreadProcessId(window, &process);
    if (thread != GetCurrentThreadId() || process != GetCurrentProcessId() || HubState(window)) return 0;
    HubWindow *state = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(HubWindow));
    if (!state) return 0;
    state->notification = RegisterWindowMessageW(L"dev.diagnostichub.desktop.genie.minimize.v1");
    if (!state->notification || !SetWindowSubclass(window, HubProcedure, 1, (DWORD_PTR)state)) {
        HeapFree(GetProcessHeap(), 0, state);
        return 0;
    }
    return state->notification;
}

__declspec(dllexport) BOOL __stdcall HubEnable(HWND window, BOOL enabled) {
    HubWindow *state = HubState(window);
    if (!state) return FALSE;
    state->enabled = enabled;
    return TRUE;
}

__declspec(dllexport) BOOL __stdcall HubBypass(HWND window, BOOL bypass) {
    HubWindow *state = HubState(window);
    if (!state) return FALSE;
    state->bypass = bypass;
    return TRUE;
}

__declspec(dllexport) BOOL __stdcall HubDetach(HWND window) {
    HubWindow *state = HubState(window);
    if (!state) return TRUE;
    if (!RemoveWindowSubclass(window, HubProcedure, 1)) return FALSE;
    HeapFree(GetProcessHeap(), 0, state);
    return TRUE;
}
