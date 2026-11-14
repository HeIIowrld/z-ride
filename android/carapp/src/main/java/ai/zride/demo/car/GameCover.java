package ai.zride.demo.car;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.drawable.Drawable;

final class GameCover extends Drawable {
    private final Bitmap image;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
    private final RectF surface = new RectF();
    private final RectF artwork = new RectF();
    private final Path clip = new Path();
    private final int accent;
    private final float corner;
    private final boolean fullFrame;
    private Shader shade;
    private Shader edgeShade;
    private static final int BACKDROP = 0xff0b0d16;

    GameCover(Context context, int resource, int accent, float corner) {
        this(context, resource, accent, corner, false);
    }

    GameCover(Context context, int resource, int accent, float corner, boolean fullFrame) {
        image = BitmapFactory.decodeResource(context.getResources(), resource);
        this.accent = accent;
        this.corner = corner;
        this.fullFrame = fullFrame;
    }

    @Override protected void onBoundsChange(Rect bounds) {
        if (bounds.isEmpty()) {
            surface.setEmpty();
            return;
        }
        surface.set(bounds);
        float scaleX = (float) bounds.width() / image.getWidth();
        float scaleY = (float) bounds.height() / image.getHeight();
        float scale = fullFrame ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
        float width = image.getWidth() * scale;
        float height = image.getHeight() * scale;
        float top = surface.centerY() - height / 2;
        artwork.set(surface.right - width, top, surface.right, top + height);
        clip.rewind();
        clip.addRoundRect(surface, corner, corner, Path.Direction.CW);
        shade = fullFrame
                ? new LinearGradient(0, surface.top, 0, surface.bottom,
                    new int[]{0x080b0d16, 0x440b0d16, 0xe80b0d16, BACKDROP},
                    new float[]{0f, .39f, .76f, 1f}, Shader.TileMode.CLAMP)
                : new LinearGradient(artwork.left, artwork.top, artwork.right, artwork.top,
                    new int[]{BACKDROP, 0xb80b0d16, 0x180b0d16, 0x000b0d16},
                    new float[]{0f, .24f, .67f, 1f}, Shader.TileMode.CLAMP);
        edgeShade = !fullFrame && surface.height() - height > 1f
                ? new LinearGradient(0, artwork.top, 0, artwork.bottom,
                    new int[]{BACKDROP, 0x000b0d16, 0x000b0d16, BACKDROP},
                    new float[]{0f, .09f, .88f, 1f}, Shader.TileMode.CLAMP)
                : null;
    }

    @Override public void draw(Canvas canvas) {
        if (surface.isEmpty()) return;
        canvas.save();
        canvas.clipPath(clip);
        canvas.drawColor(BACKDROP);
        canvas.drawBitmap(image, null, artwork, paint);
        paint.setShader(shade);
        canvas.drawRect(artwork, paint);
        if (edgeShade != null) {
            paint.setShader(edgeShade);
            canvas.drawRect(artwork, paint);
        }
        paint.setShader(null);
        paint.setColor(accent);
        canvas.drawRect(surface.left, surface.top, surface.left + corner / 4, surface.bottom, paint);
        canvas.restore();
    }

    @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); }
    @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); }
    @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
}
