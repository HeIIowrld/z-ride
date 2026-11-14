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
    enum Layout { FIT, GAME, HOME }

    private final Bitmap image;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
    private final RectF surface = new RectF();
    private final RectF artwork = new RectF();
    private final Path clip = new Path();
    private final int accent;
    private final float corner;
    private final Layout layout;
    private Shader shade;
    private Shader edgeShade;
    private static final int BACKDROP = 0xff090f27;

    GameCover(Context context, int resource, int accent, float corner, Layout layout) {
        image = BitmapFactory.decodeResource(context.getResources(), resource);
        this.accent = accent;
        this.corner = corner;
        this.layout = layout;
    }

    @Override protected void onBoundsChange(Rect bounds) {
        if (bounds.isEmpty()) {
            surface.setEmpty();
            return;
        }
        surface.set(bounds);
        float scaleX = (float) bounds.width() / image.getWidth();
        float scaleY = (float) bounds.height() / image.getHeight();
        float scale = layout == Layout.FIT ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY);
        float width = image.getWidth() * scale;
        float height = image.getHeight() * scale;
        float top = surface.centerY() - height / 2;
        artwork.set(surface.right - width, top, surface.right, top + height);
        clip.rewind();
        clip.addRoundRect(surface, corner, corner, Path.Direction.CW);
        switch (layout) {
            case HOME:
                shade = new LinearGradient(surface.left, 0, surface.right, 0,
                        new int[]{BACKDROP, 0x99090f27, 0x00090f27},
                        new float[]{0f, .32f, .70f}, Shader.TileMode.CLAMP);
                break;
            case GAME:
                shade = new LinearGradient(0, surface.top, 0, surface.bottom,
                        new int[]{0x08090f27, 0x44090f27, 0xe8090f27, BACKDROP},
                        new float[]{0f, .39f, .76f, 1f}, Shader.TileMode.CLAMP);
                break;
            default:
                shade = new LinearGradient(artwork.left, artwork.top, artwork.right, artwork.top,
                        new int[]{BACKDROP, 0xb8090f27, 0x18090f27, 0x00090f27},
                        new float[]{0f, .24f, .67f, 1f}, Shader.TileMode.CLAMP);
        }
        edgeShade = layout == Layout.FIT && surface.height() - height > 1f
                ? new LinearGradient(0, artwork.top, 0, artwork.bottom,
                    new int[]{BACKDROP, 0x00090f27, 0x00090f27, BACKDROP},
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
        if (accent != 0) {
            paint.setColor(accent);
            canvas.drawRect(surface.left, surface.top, surface.left + corner / 4, surface.bottom, paint);
        }
        canvas.restore();
    }

    @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); }
    @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); }
    @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
}
