"""Execute the installed helper logic against software serial and termios fixtures."""
import contextlib
import copy
import io
import json
import sys
import types

source = sys.stdin.read()
for scenario in ("ok", "mismatch", "cancel", "busy", "restoration-failure"):
    state = {"attrs": [1, 2, 3, 4, 5, 6, [0] * 32], "restored": False, "closed": False, "exclusive": False, "written": b"", "clock": 0}
    original = copy.deepcopy(state["attrs"])
    os = types.ModuleType("os")
    os.O_RDWR, os.O_NOCTTY, os.O_NONBLOCK = 1, 2, 4
    os.open = lambda *args: 42
    os.close = lambda fd: state.update(closed=True)
    def write(fd, data):
        if scenario == "cancel":
            raise KeyboardInterrupt()
        state["written"] += data
        return len(data)
    os.write = write
    os.read = lambda fd, count: b"wrong" if scenario == "mismatch" else state["written"][:count]
    termios = types.ModuleType("termios")
    for index, name in enumerate(("TIOCEXCL", "TIOCNXCL", "CS8", "CREAD", "CLOCAL", "TCSANOW", "TCIOFLUSH", "B115200"), 1):
        setattr(termios, name, index)
    termios.VMIN, termios.VTIME = 0, 1
    termios.tcgetattr = lambda fd: copy.deepcopy(state["attrs"])
    def settings(fd, when, attrs):
        if attrs == original:
            if scenario == "restoration-failure":
                raise OSError("restoration failed")
            state["restored"] = True
        state["attrs"] = copy.deepcopy(attrs)
    termios.tcsetattr, termios.tcflush = settings, lambda *args: None
    fcntl = types.ModuleType("fcntl")
    def ioctl(fd, operation):
        if operation == termios.TIOCEXCL and scenario == "busy":
            raise OSError(16, "Resource busy")
        state["exclusive"] = operation == termios.TIOCEXCL
    fcntl.ioctl = ioctl
    select = types.ModuleType("select")
    select.select = lambda reads, writes, errors, timeout: (reads, writes, [])
    time = types.ModuleType("time")
    def now():
        state["clock"] += 0.02
        return state["clock"]
    time.monotonic = now
    signal = types.ModuleType("signal")
    signal.SIGTERM, signal.signal = 15, lambda *args: None
    modules = {name: module for name, module in locals().copy().items() if name in ("os", "termios", "fcntl", "select", "time", "signal")}
    saved = {name: sys.modules.get(name) for name in modules}
    args = sys.argv
    output = io.StringIO()
    try:
        sys.modules.update(modules)
        sys.argv = ["helper", "/dev/ttyFixture", "115200", "616263", "0.1"]
        with contextlib.redirect_stdout(output):
            exec(compile(source, "installed-uart-helper", "exec"), {})
    finally:
        sys.argv = args
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
    result = json.loads(output.getvalue().split("HUB-UART-RESULT ")[1])
    assert state["closed"] and not state["exclusive"], scenario
    assert result["execution"] == {"ok": "ok", "mismatch": "mismatch", "cancel": "interrupted", "busy": "blocked", "restoration-failure": "ok"}[scenario], result
    assert result["cleanup"] == (scenario != "restoration-failure"), result
    if scenario == "ok":
        assert result["measured"] == "616263" and state["restored"]
    print("UART software fixture:", scenario, "verified")
