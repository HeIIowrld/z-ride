package ai.zride.demo.common;

import android.content.Context;
import android.graphics.*;
import android.view.MotionEvent;
import android.view.View;
import org.json.*;

/** Vehicle-relative aiming prototype. Graphics are original Canvas primitives. */
public final class SeatArenaView extends View {
    public interface AimListener { void onAim(float angle); }
    private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
    private AimListener listener;
    private String seat = "DRIVER", state = "LOCKED";
    private float aim = 90;
    private boolean active;
    private JSONArray zombies=new JSONArray();
    private JSONObject lastShot;
    public SeatArenaView(Context context) { super(context); setContentDescription("좌석별 사격 범위 프로토타입"); }
    public void update(String seat, String state, boolean active) { this.seat=seat;this.state=state;this.active=active;invalidate(); }
    public void setAimListener(AimListener value) { listener=value; }
    public void setAim(float value) { aim=value;invalidate(); }
    public void setRoom(JSONObject room) { zombies=room.optJSONArray("zombies");if(zombies==null)zombies=new JSONArray();JSONObject stats=room.optJSONObject("stats");lastShot=stats==null?null:stats.optJSONObject("lastShot");invalidate(); }
    @Override protected void onDraw(Canvas c) {
        super.onDraw(c);
        float w=getWidth(),h=getHeight(),cx=w/2,cy=h/2,r=Math.min(w,h)*.34f;
        c.drawColor(Color.rgb(12,22,31));
        p.setStyle(Paint.Style.FILL);
        float lo=-180,hi=180;
        int col=Color.rgb(47,198,158);
        if (seat.equals("FRONT_PASSENGER")) {lo=-45;hi=90;col=Color.rgb(66,184,244);}
        if (seat.equals("REAR_LEFT")) {lo=-180;hi=-45;col=Color.rgb(173,124,242);}
        if (seat.equals("REAR_RIGHT")) {lo=45;hi=180;col=Color.rgb(245,172,72);}
        p.setColor(col);p.setAlpha(65);
        c.drawArc(new RectF(cx-r,cy-r,cx+r,cy+r),lo-90,hi-lo,true,p);
        p.setAlpha(255);p.setStyle(Paint.Style.STROKE);p.setStrokeWidth(2);p.setColor(Color.rgb(63,83,98));
        c.drawCircle(cx,cy,r,p);
        for (int i=0;i<zombies.length();i++) {
            JSONObject z=zombies.optJSONObject(i);if(z==null)continue;float angle=(float)z.optDouble("angleDeg");int hp=z.optInt("hp");
            double a=Math.toRadians(angle);
            float x=cx+(float)Math.sin(a)*r*.88f,y=cy-(float)Math.cos(a)*r*.88f;
            p.setStyle(Paint.Style.FILL);p.setColor(hp>0?Color.rgb(114,157,81):Color.rgb(62,68,71));c.drawCircle(x,y,14,p);
            p.setColor(Color.rgb(9,20,20));c.drawCircle(x-4,y-2,2,p);c.drawCircle(x+4,y-2,2,p);
            p.setTextSize(10);c.drawText("Z",x-3,y+8,p);
            p.setColor(Color.WHITE);p.setTextSize(12);c.drawText("HP "+hp,x-14,y+30,p);
        }
        p.setColor(Color.rgb(222,232,237));p.setStyle(Paint.Style.FILL);c.drawRoundRect(cx-24,cy-43,cx+24,cy+43,9,9,p);
        p.setColor(Color.rgb(46,87,105));c.drawRect(cx-17,cy-30,cx+17,cy-15,p);
        p.setColor(col);p.setStyle(Paint.Style.STROKE);p.setStrokeWidth(4);
        double a=Math.toRadians(aim);c.drawLine(cx,cy,cx+(float)Math.sin(a)*r,cy-(float)Math.cos(a)*r,p);
        if(lastShot!=null&&lastShot.optBoolean("accepted")){double shot=Math.toRadians(lastShot.optDouble("angleDeg"));p.setColor(lastShot.optBoolean("hit")?Color.YELLOW:Color.GRAY);p.setStrokeWidth(2);c.drawLine(cx,cy,cx+(float)Math.sin(shot)*r*.88f,cy-(float)Math.cos(shot)*r*.88f,p);}
        p.setStyle(Paint.Style.FILL);p.setColor(Color.WHITE);p.setTextSize(16);
        c.drawText("FRONT 0°",cx-37,25,p);
        c.drawText(seat+"  "+state,16,h-17,p);
        if (!active) {p.setColor(0xaa081016);c.drawRect(0,0,w,h,p);p.setColor(Color.WHITE);p.setTextSize(20);c.drawText("PAUSED / WAITING",cx-90,cy,p);}
    }
    @Override public boolean onTouchEvent(MotionEvent e) {
        if (!active || seat.equals("DRIVER")) return true;
        if (e.getAction()==MotionEvent.ACTION_UP) {
            float angle=(float)Math.toDegrees(Math.atan2(e.getX()-getWidth()/2f,getHeight()/2f-e.getY()));
            aim=angle;invalidate();if(listener!=null)listener.onAim(angle);performClick();
        }
        return true;
    }
    @Override public boolean performClick() { super.performClick();return true; }
}
