package ai.zride.demo.common;

import android.app.Dialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.function.BiConsumer;

/** Parked vehicle party lineup. The QR is an action on an open seat. */
final class CrewLobby extends LinearLayout {
    private static final int INK = 0xfff8f6ff;
    private static final int MUTED = 0xffb5b4cc;
    private static final int MINT = DemoActivity.PLY_MINT;
    private static final int AMBER = 0xffffcf8a;
    private static final String[] SEATS = {"DRIVER", "FRONT_PASSENGER", "REAR_LEFT", "REAR_RIGHT"};
    private static final String[] NAMES = {"운전석", "조수석", "뒷좌석 왼쪽", "뒷좌석 오른쪽"};
    private static final int[] ACCENTS = {MINT, 0xffa8b5ff, 0xffffbb8b, 0xffd3aaff};

    private final Slot[] slots = new Slot[SEATS.length];
    private final TextView count;
    private final Button inviteCrew;
    private final TextView inviteTitle;
    private final TextView inviteSeatHint;
    private final Dialog inviteDialog;
    private final FrameLayout qrFrame;
    private final ImageView qr;
    private int occupiedSeats;

    CrewLobby(Context context, Drawable cover, ImageView qr, TextView hint, Button renew,
              boolean compact, Runnable requestInvite, BiConsumer<String, String> approve) {
        super(context);
        this.qr = qr;
        setOrientation(VERTICAL);
        setBackground(cover);
        setPadding(dp(20), dp(20), dp(20), dp(20));

        LinearLayout header = new LinearLayout(context);
        header.setGravity(Gravity.CENTER_VERTICAL);
        ImageView symbol = new ImageView(context);
        symbol.setImageResource(R.drawable.ic_ply_launcher);
        symbol.setScaleType(ImageView.ScaleType.CENTER_CROP);
        symbol.setBackground(surface(0xff0a1723, 0xff0a1723, DemoActivity.PLY_BORDER, 6));
        symbol.setClipToOutline(true);
        header.addView(symbol, new LayoutParams(dp(48), dp(48)));
        TextView title = label("크루 로비", 36, Typeface.BOLD, INK);
        LayoutParams titleParams = new LayoutParams(0, -2, 1);
        titleParams.setMarginStart(dp(10));
        header.addView(title, titleParams);
        count = label("", 17, Typeface.BOLD, MINT);
        count.setPadding(dp(12), dp(8), dp(12), dp(8));
        count.setBackground(surface(0xff14353f, 0xff122432, 0xff426962, 6));
        header.addView(count);
        addView(header, new LayoutParams(-1, -2));

        inviteCrew = new Button(context);
        inviteCrew.setAllCaps(false);
        inviteCrew.setTextSize(19);
        inviteCrew.setTypeface(null, Typeface.BOLD);
        inviteCrew.setTextColor(0xff062b29);
        inviteCrew.setBackground(ripple(surface(MINT, MINT, MINT, 8)));
        inviteCrew.setText("동승자 초대");
        inviteCrew.setOnClickListener(view -> openInvite(-1, requestInvite));
        LayoutParams inviteAction = new LayoutParams(-1, dp(54));
        inviteAction.topMargin = dp(12);
        addView(inviteCrew, inviteAction);

        boolean wide = !compact && getResources().getConfiguration().screenWidthDp >= 700;
        int portraitHeight = compact ? 98 : wide ? Math.min(210, Math.max(112,
                getResources().getConfiguration().screenHeightDp / 3 - 26)) : 88;
        LinearLayout row = null;
        for (int index = 0; index < slots.length; index++) {
            if (index % (wide ? 4 : 2) == 0) {
                row = new LinearLayout(context);
                LayoutParams rowParams = new LayoutParams(-1, -2);
                rowParams.topMargin = dp(10);
                addView(row, rowParams);
            }
            final int slotIndex = index;
            Slot slot = new Slot(context, index, portraitHeight, () -> openInvite(slotIndex, requestInvite), approve);
            slots[index] = slot;
            LayoutParams params = new LayoutParams(0, -2, 1);
            if (index % (wide ? 4 : 2) != 0) params.setMarginStart(dp(12));
            row.addView(slot, params);
        }

        inviteDialog = new Dialog(context);
        inviteDialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        LinearLayout invite = new LinearLayout(context);
        invite.setOrientation(VERTICAL);
        invite.setPadding(dp(24), dp(18), dp(24), dp(16));
        invite.setBackground(surface(DemoActivity.PLY_SURFACE, DemoActivity.PLY_NAVY, DemoActivity.PLY_BORDER, 12));
        LinearLayout top = new LinearLayout(context);
        top.setGravity(Gravity.CENTER_VERTICAL);
        inviteTitle = label("", 25, Typeface.BOLD_ITALIC, MINT);
        top.addView(inviteTitle, new LayoutParams(0, -2, 1));
        Button close = new Button(context);
        close.setText("닫기");
        close.setAllCaps(false);
        close.setTextColor(INK);
        close.setBackground(ripple(surface(0xff233851, 0xff172841, DemoActivity.PLY_BORDER, 6)));
        close.setOnClickListener(view -> dismissInvite());
        top.addView(close, new LayoutParams(dp(64), dp(48)));
        invite.addView(top);
        inviteSeatHint = label("", 16, Typeface.NORMAL, INK);
        inviteSeatHint.setGravity(Gravity.CENTER);
        inviteSeatHint.setSingleLine(false);
        invite.addView(inviteSeatHint, new LayoutParams(-1, -2));
        hint.setTextColor(INK);
        hint.setGravity(Gravity.CENTER);
        invite.addView(hint, new LayoutParams(-1, -2));

        qrFrame = new FrameLayout(context);
        qrFrame.setBackground(surface(0xff204454, DemoActivity.PLY_NAVY, MINT, 8));
        int qrSize = Math.min(312, Math.max(144, getResources().getConfiguration().screenHeightDp - 210));
        qrFrame.addView(qr, new FrameLayout.LayoutParams(dp(qrSize), dp(qrSize), Gravity.CENTER));
        LayoutParams frameParams = new LayoutParams(dp(qrSize + 24), dp(qrSize + 24));
        frameParams.gravity = Gravity.CENTER_HORIZONTAL;
        frameParams.topMargin = dp(8);
        invite.addView(qrFrame, frameParams);
        invite.addView(renew);
        inviteDialog.setContentView(invite);
        Window window = inviteDialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            window.setDimAmount(.74f);
        }
        render(null);
    }

    private void openInvite(int seat, Runnable requestInvite) {
        inviteTitle.setText(seat < 0 ? "크루 참가 QR" : NAMES[seat] + " 초대");
        inviteTitle.setTextColor(seat < 0 ? MINT : ACCENTS[seat]);
        inviteSeatHint.setText(seat < 0 ? "폰 카메라로 스캔하고 빈 좌석을 선택하세요."
                : "폰 카메라로 스캔하고 " + NAMES[seat] + "을 선택하세요.");
        inviteDialog.show();
        Window window = inviteDialog.getWindow();
        if (window != null) window.setLayout(dp(Math.min(440,
                getResources().getConfiguration().screenWidthDp - 24)), -2);
        requestInvite.run();
    }

    boolean isInviteOpen() { return inviteDialog.isShowing(); }

    void dismissInvite() {
        if (inviteDialog.isShowing()) inviteDialog.dismiss();
    }

    void showQr(boolean visible) {
        qr.setVisibility(visible ? VISIBLE : INVISIBLE);
        qrFrame.setVisibility(visible ? VISIBLE : GONE);
    }

    void render(JSONArray members) {
        int connected = 0;
        int nextOccupiedSeats = 0;
        for (Slot slot : slots) {
            JSONObject member = occupant(members, slot.seat);
            if (slot.update(member)) connected++;
            if (slot.index != 0 && member != null) nextOccupiedSeats |= 1 << slot.index;
        }
        if ((nextOccupiedSeats & ~occupiedSeats) != 0) dismissInvite();
        occupiedSeats = nextOccupiedSeats;
        int empty = slots.length - 1 - Integer.bitCount(occupiedSeats);
        inviteCrew.setText(empty == 0 ? "크루 초대 마감" : "동승자 초대  ·  " + empty + "자리");
        inviteCrew.setVisibility(empty == 0 ? GONE : VISIBLE);
        String filled = connected + " / " + slots.length + "  합류";
        if (!filled.contentEquals(count.getText())) count.setText(filled);
    }

    private JSONObject occupant(JSONArray members, String seat) {
        JSONObject pending = null;
        for (int i = 0; members != null && i < members.length(); i++) {
            JSONObject member = members.optJSONObject(i);
            if (member == null || !seat.equals(member.optString("seat"))) continue;
            if (member.optBoolean("approved")) return member;
            if (pending == null) pending = member;
        }
        return pending;
    }

    private int dp(int size) { return Math.round(size * getResources().getDisplayMetrics().density); }

    private TextView label(String value, int size, int style, int color) {
        TextView label = new TextView(getContext());
        label.setText(value);
        label.setTextSize(size);
        label.setTypeface(Typeface.create("sans-serif-condensed", style));
        label.setTextColor(color);
        label.setSingleLine(true);
        label.setEllipsize(TextUtils.TruncateAt.END);
        return label;
    }

    private GradientDrawable surface(int top, int bottom, int border, int corner) {
        GradientDrawable drawable = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{top, bottom});
        drawable.setCornerRadius(dp(corner));
        drawable.setStroke(dp(1), border);
        return drawable;
    }

    private RippleDrawable ripple(Drawable surface) {
        return new RippleDrawable(ColorStateList.valueOf(0x4d9aacee), surface, null);
    }

    private final class Slot extends LinearLayout {
        final String seat;
        private final int index;
        private final TextView name;
        private final TextView state;
        private final Button action;
        private final Portrait portrait;
        private final Runnable invite;
        private final BiConsumer<String, String> approve;
        private String signature = "";

        Slot(Context context, int index, int portraitHeight, Runnable invite, BiConsumer<String, String> approve) {
            super(context);
            this.index = index;
            this.invite = invite;
            this.approve = approve;
            seat = SEATS[index];
            setOrientation(VERTICAL);
            setPadding(dp(13), dp(12), dp(13), dp(12));

            TextView seatLabel = label(NAMES[index], 16, Typeface.BOLD, ACCENTS[index]);
            addView(seatLabel, new LayoutParams(-1, -2));
            portrait = new Portrait(context, ACCENTS[index], index);
            addView(portrait, new LayoutParams(-1, dp(portraitHeight)));
            name = label("", 26, Typeface.BOLD, INK);
            addView(name, new LayoutParams(-1, -2));

            FrameLayout footer = new FrameLayout(context);
            state = label("", 15, Typeface.BOLD, MUTED);
            state.setGravity(Gravity.CENTER_VERTICAL);
            footer.addView(state, new FrameLayout.LayoutParams(-1, -1));
            action = new Button(context);
            action.setAllCaps(false);
            action.setTextSize(15);
            action.setTypeface(null, Typeface.BOLD);
            action.setSingleLine(true);
            action.setPadding(dp(4), 0, dp(4), 0);
            footer.addView(action, new FrameLayout.LayoutParams(-1, -1));
            LayoutParams footerParams = new LayoutParams(-1, dp(48));
            footerParams.topMargin = dp(5);
            addView(footer, footerParams);
        }

        boolean update(JSONObject member) {
            boolean host = index == 0;
            boolean open = member == null && !host;
            boolean pending = member != null && !member.optBoolean("approved");
            boolean connected = host || (member != null && !pending && member.optBoolean("connected"));
            String nickname = host ? "내 차량" : open ? "빈 자리" : member.optString("nickname");
            String memberId = member == null ? "" : member.optString("memberId");
            String next = memberId + '\n' + nickname + '\n' + pending + connected;
            if (next.equals(signature)) return connected;
            signature = next;

            int accent = ACCENTS[index];
            int tint = pending ? AMBER : connected ? accent : 0xff696d91;
            setBackground(surface(open ? 0xc21a2945 : 0xde20314e, 0xe90e192d, tint, 7));
            name.setText(nickname);
            name.setTextColor(open ? MUTED : INK);
            portrait.update(!open, pending, nickname);
            state.setText(host ? "●  파티장" : connected ? "✓  합류 완료" : "연결 끊김");
            state.setTextColor(connected ? tint : MUTED);
            state.setVisibility(open || pending ? GONE : VISIBLE);
            action.setVisibility(open || pending ? VISIBLE : GONE);
            setOnClickListener(open ? view -> invite.run() : null);
            setClickable(open);
            if (open || pending) {
                action.setText(open ? "+  초대" : "승인 대기  ›");
                action.setTextColor(open ? INK : 0xff332008);
                action.setContentDescription(open ? NAMES[index] + " 초대" : nickname + " · " + NAMES[index] + " 승인");
                action.setBackground(ripple(open ? surface(0xff353953, 0xff23253e, tint, 5)
                        : surface(0xffffda9f, AMBER, AMBER, 5)));
                action.setOnClickListener(view -> {
                    if (open) invite.run();
                    else approve.accept(memberId, seat);
                });
            }
            return connected;
        }
    }

    private static final class Portrait extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path profile = new Path();
        private final Path visor = new Path();
        private final Path jacket = new Path();
        private final int accent;
        private final int index;
        private boolean filled;
        private boolean pending;
        private String initial = "";
        private Shader glow;
        private Shader armor;

        Portrait(Context context, int accent, int index) {
            super(context);
            this.accent = accent;
            this.index = index;
            setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
            shape(profile, -48, 44, -43, 20, -31, 10, -17, 5, -13, 0, -20, -9,
                    -24, -25, -19, -37, -8, -45, 9, -45, 20, -36, 24, -25,
                    21, -10, 14, 0, 17, 5, 31, 10, 43, 20, 48, 44);
            shape(visor, -23, -26, -15, -29, 15, -29, 23, -26, 19, -17, 13, -12,
                    -10, -12, -19, -17);
            shape(jacket, -46, 39, -36, 22, -19, 15, 0, 24, 19, 15, 36, 22, 46, 39,
                    27, 32, 0, 40, -27, 32);
            paint.setTypeface(Typeface.create("sans-serif-condensed", Typeface.BOLD));
            paint.setTextAlign(Paint.Align.CENTER);
        }

        private void shape(Path path, float... points) {
            path.moveTo(points[0], points[1]);
            for (int i = 2; i < points.length; i += 2) path.lineTo(points[i], points[i + 1]);
            path.close();
        }

        void update(boolean filled, boolean pending, String nickname) {
            this.filled = filled;
            this.pending = pending;
            initial = nickname.isEmpty() ? "•" : new String(Character.toChars(nickname.codePointAt(0)));
            int color = pending ? AMBER : accent;
            glow = new android.graphics.RadialGradient(0, -3, 65,
                    new int[]{(color & 0xffffff) | (filled ? 0x60000000 : 0x28000000), 0x00000000},
                    null, Shader.TileMode.CLAMP);
            armor = new LinearGradient(-24, -42, 24, 38,
                    new int[]{color, 0xff252a46, 0xff111524}, new float[]{0, .5f, 1}, Shader.TileMode.CLAMP);
            invalidate();
        }

        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            int color = pending ? AMBER : accent;
            float scale = Math.min(getWidth(), getHeight()) / 112f;
            if (scale <= 0) return;
            canvas.save();
            canvas.translate(getWidth() * .5f, getHeight() * .52f);
            canvas.scale(scale, scale);
            float extent = getWidth() / (2 * scale);
            paint.setStyle(Paint.Style.FILL);
            paint.setShader(glow);
            canvas.drawRect(-extent, -54, extent, 54, paint);
            paint.setShader(null);
            paint.setStrokeWidth(.55f);
            paint.setColor((color & 0xffffff) | 0x26000000);
            for (int x = -55; x <= 55; x += 11) canvas.drawLine(x, -43, x * 1.43f, 49, paint);
            for (int y = -47; y <= 52; y += 8) canvas.drawLine(-extent, y, extent, y, paint);
            canvas.drawLine(-extent, 47, extent, 47, paint);
            if (filled) {
                paint.setShader(armor);
                canvas.drawPath(profile, paint);
                paint.setShader(null);
                paint.setColor(0xff121828);
                canvas.drawPath(visor, paint);
                paint.setColor((color & 0xffffff) | 0x5a000000);
                canvas.drawPath(jacket, paint);
                paint.setStrokeWidth(1.4f);
                canvas.drawLine(-17, -22, 14 - index * 3, -22, paint);
            }
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(.85f);
            paint.setColor((color & 0xffffff) | (filled ? 0xdd000000 : 0x72000000));
            canvas.drawPath(profile, paint);
            if (filled) canvas.drawPath(visor, paint);
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(filled ? INK : MUTED);
            paint.setTextSize(filled ? 19 : 26);
            canvas.drawText(filled ? initial : "+", 0, 18, paint);
            canvas.restore();
        }
    }
}
