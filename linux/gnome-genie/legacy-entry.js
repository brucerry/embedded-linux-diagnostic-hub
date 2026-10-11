// GNOME 42 module adapter. The shared modern effect body is appended by packaging.
// No ESM loader or modern Extension base class is available in this runtime.
const { Clutter, Gio, GLib, GObject, Graphene, Shell, Meta } = imports.gi;
const Main = imports.ui.main;
const Config = imports.misc.config;
const ByteArray = imports.byteArray;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const { APPLICATION_ID, WINDOW_CLASS, SHELL_MAJORS, anchorEdge, rectangle, deform } =
    Me.imports.geometry;
const { BUILD } = Me.imports['build-info'];

class Extension {
    constructor() {
        this.path = Me.path;
    }
}

function init() {
    return new DiagnosticHubGenie();
}
