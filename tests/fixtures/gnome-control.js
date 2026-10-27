import Gtk from 'gi://Gtk?version=4.0';
const application = new Gtk.Application({ application_id: 'dev.diagnostichub.Control' });
application.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({
        application,
        title: ARGV[0],
        default_width: 320,
        default_height: 240,
    });
    window.set_child(new Gtk.Label({ label: 'Non-target qualification control' }));
    window.present();
});
application.run([]);
