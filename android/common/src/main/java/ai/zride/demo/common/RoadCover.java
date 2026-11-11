package ai.zride.demo.common;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.Shader;
import android.graphics.drawable.Drawable;

/** Scenic cover for the native vehicle lobby. Coordinates are relative to the cover. */
final class RoadCover extends Drawable {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path shape = new Path();
    private LinearGradient sky;
    private LinearGradient shade;

    @Override protected void onBoundsChange(Rect bounds) {
        sky = new LinearGradient(0, 0, 1000, 300, 0xff101c32, 0xff336877, Shader.TileMode.CLAMP);
        shade = new LinearGradient(0, 0, 790, 0, 0xff111a2c, 0x00111a2c, Shader.TileMode.CLAMP);
    }

    @Override public void draw(Canvas canvas) {
        Rect bounds = getBounds();
        canvas.save();
        canvas.translate(bounds.left, bounds.top);
        canvas.scale(bounds.width() / 1000f, bounds.height() / 320f);
        paint.setShader(sky);
        canvas.drawRect(0, 0, 1000, 320, paint);
        paint.setShader(null);
        paint.setColor(0xffffb47b);
        canvas.drawOval(765, 35, 855, 125, paint);
        polygon(canvas, 0xff396371, 0, 215, 240, 105, 430, 179, 603, 68, 751, 160, 889, 88, 1000, 141, 1000, 320, 0, 320);
        polygon(canvas, 0xff213e53, 0, 221, 220, 184, 442, 238, 647, 134, 786, 198, 918, 143, 1000, 179, 1000, 320, 0, 320);
        polygon(canvas, 0xff152738, 0, 250, 397, 213, 707, 208, 1000, 255, 1000, 320, 0, 320);
        polygon(canvas, 0xff8296a0, 527, 320, 747, 204, 768, 204, 951, 320);
        polygon(canvas, 0xff203043, 545, 320, 751, 205, 765, 205, 926, 320);
        polygon(canvas, 0xfff8cf91, 724, 320, 736, 320, 744, 295, 739, 295);
        polygon(canvas, 0xfff8cf91, 743, 284, 748, 284, 752, 265, 749, 265);
        polygon(canvas, 0xfff8cf91, 751, 255, 754, 255, 757, 239, 755, 239);
        paint.setShader(shade);
        canvas.drawRect(0, 0, 1000, 320, paint);
        paint.setShader(null);
        canvas.restore();
    }

    private void polygon(Canvas canvas, int color, float... points) {
        shape.reset();
        shape.moveTo(points[0], points[1]);
        for (int i = 2; i < points.length; i += 2) shape.lineTo(points[i], points[i + 1]);
        shape.close();
        paint.setColor(color);
        canvas.drawPath(shape, paint);
    }

    @Override public void setAlpha(int alpha) {}
    @Override public void setColorFilter(ColorFilter filter) {}
    @Override public int getOpacity() { return PixelFormat.OPAQUE; }
}
