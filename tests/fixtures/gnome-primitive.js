void (async () => {
    const { default: Gio } = await import('gi://Gio');
    const { default: Cogl } = await import('gi://Cogl');
    const { default: Shell } = await import('gi://Shell');
    const context = global.stage.get_context().get_backend().get_cogl_context();
    const report = {
        ok: false,
        scope: 'diagnostic standalone Cogl primitive framebuffer, not stage qualification',
        phases: [],
    };
    try {
        for (const mode of [
            'rectangle',
            'primitive',
            'primitive-depth',
            'primitive-color',
            'primitive-packed',
        ]) {
            const texture = Cogl.Texture2D.new_with_size(context, 260, 200);
            const framebuffer = Cogl.Offscreen.new_with_texture(texture);
            framebuffer.allocate();
            framebuffer.orthographic(0, 0, 260, 200, -1, 1);
            framebuffer.clear4f(Cogl.BufferBit.COLOR | Cogl.BufferBit.DEPTH, 0, 0, 0, 1);
            const pipeline = Cogl.Pipeline.new(context);
            const color = new Cogl.Color();
            color.init_from_4f(230 / 255, 30 / 255, 200 / 255, 1);
            pipeline.set_color(color);
            if (mode !== 'rectangle' && mode !== 'primitive') {
                const depth = new Cogl.DepthState();
                depth.init();
                depth.set_test_enabled(true);
                depth.set_test_function(Cogl.DepthTestFunction.LEQUAL);
                pipeline.set_depth_state(depth);
            }
            if (mode === 'rectangle') {
                framebuffer.draw_rectangle(pipeline, 65, 50, 195, 150);
            } else if (mode === 'primitive-packed') {
                const points = [
                    [65, 50, 0, 0],
                    [195, 50, 1, 0],
                    [195, 150, 1, 1],
                    [65, 50, 0, 0],
                    [195, 150, 1, 1],
                    [65, 150, 0, 1],
                ];
                const bytes = new Uint8Array(24 * points.length);
                const view = new DataView(bytes.buffer);
                points.forEach(([x, y, s, t], i) => {
                    const o = i * 24;
                    [x, y, 0, s, t].forEach((value, j) => view.setFloat32(o + j * 4, value, true));
                    bytes.set([255, 255, 255, 255], o + 20);
                });
                const buffer = Cogl.AttributeBuffer.new(context, bytes);
                const attrs = [
                    Cogl.Attribute.new(
                        buffer,
                        'cogl_position_in',
                        24,
                        0,
                        3,
                        Cogl.AttributeType.FLOAT,
                    ),
                    Cogl.Attribute.new(
                        buffer,
                        'cogl_tex_coord0_in',
                        24,
                        12,
                        2,
                        Cogl.AttributeType.FLOAT,
                    ),
                    Cogl.Attribute.new(
                        buffer,
                        'cogl_color_in',
                        24,
                        20,
                        4,
                        Cogl.AttributeType.UNSIGNED_BYTE,
                    ),
                ];
                const primitive = Cogl.Primitive.new_with_attributes(
                    Cogl.VerticesMode.TRIANGLES,
                    6,
                    attrs,
                );
                primitive.draw(framebuffer, pipeline);
            } else if (mode === 'primitive-color') {
                const data = [
                    [65, 50],
                    [195, 50],
                    [195, 150],
                    [65, 50],
                    [195, 150],
                    [65, 150],
                ].map(([x, y]) => {
                    const v = new Cogl.VertexP2C4();
                    v.x = x;
                    v.y = y;
                    v.r = 230;
                    v.g = 30;
                    v.b = 200;
                    v.a = 255;
                    return v;
                });
                Cogl.Primitive.new_p2c4(context, Cogl.VerticesMode.TRIANGLES, data).draw(
                    framebuffer,
                    pipeline,
                );
            } else {
                const data = [
                    [65, 50],
                    [195, 50],
                    [195, 150],
                    [65, 50],
                    [195, 150],
                    [65, 150],
                ].map(([x, y]) => {
                    const vertex = new Cogl.VertexP2();
                    vertex.x = x;
                    vertex.y = y;
                    return vertex;
                });
                Cogl.Primitive.new_p2(context, Cogl.VerticesMode.TRIANGLES, data).draw(
                    framebuffer,
                    pipeline,
                );
            }
            framebuffer.finish();
            const stream = Gio.MemoryOutputStream.new_resizable();
            await Shell.Screenshot.composite_to_stream(
                texture,
                0,
                0,
                -1,
                -1,
                1,
                null,
                0,
                0,
                1,
                stream,
            );
            stream.close(null);
            Gio.File.new_for_path('__OUTPUT__/' + mode + '.png').replace_contents(
                stream.steal_as_bytes().get_data(),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null,
            );
            report.phases.push({ mode, texture: [260, 200], renderedToOwnFramebuffer: true });
        }
        report.ok = true;
    } catch (error) {
        report.error = String(error) + '\n' + String(error.stack);
    } finally {
        Gio.File.new_for_path('__OUTPUT__/mesh.json').replace_contents(
            JSON.stringify(report),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
        );
    }
})();
