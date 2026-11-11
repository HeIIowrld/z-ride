package ai.zride.demo.common;

import android.app.Activity;
import android.os.*;
import android.graphics.Color;
import android.graphics.Bitmap;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.MultiFormatWriter;
import com.google.zxing.common.BitMatrix;
import android.util.Log;
import android.view.View;
import android.widget.*;
import org.json.*;
import java.io.File;
import java.io.FileWriter;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.ArrayList;
import java.util.concurrent.ConcurrentHashMap;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;

public abstract class DemoActivity extends Activity implements RoomClient.Listener {
    protected final Handler main = new Handler(Looper.getMainLooper());
    protected RoomClient client;
    protected boolean foreground=false, localAllowed=false, connected=false;
    protected JSONObject latestVehicle=new JSONObject(), room;
    protected TextView diagnostics, status, roomLabel, resultLabel, memberLabel;
    private TextView statsLabel;
    private TextView extraDiagnostics;
    protected View vehicleMasthead;
    protected TextView parkedHint;
    private LinearLayout partyWelcome;
    private GameAudio gameAudio;
    private long lastShotTime;
    private boolean sawRoom;
    private CheckBox soundToggle;
    private final ConcurrentHashMap<String,String> pendingCommands=new ConcurrentHashMap<>();
    private String pendingTestAction;
    private float pendingTestAngle;
    private long testDeadline;
    private final Runnable testRunner=this::runTestAction;
    private LinearLayout collectionPanel,collectionFixtures;
    private TextView collectionSummary;
    private CheckBox passengerConfirmation;
    private boolean passengerApproved,pendingPassengerConfirmation;
    private String pendingPickupId;
    private String pendingSpawnId;
    private final ArrayList<Button> fireButtons=new ArrayList<>();
    private EditText serverInput, codeInput, nicknameInput, accessKeyInput;
    private Button connectButton;
    private Spinner seats;
    private LinearLayout approvals, gamePanel, lobby;
    private SeatArenaView arena;
    private ImageView inviteQr;
    private TextView inviteInfo;
    private Button inviteButton;
    private String inviteRoomId;
    private String invitePendingRoomId;
    private String approvalSignature="";
    private final Runnable expireInvite=()->{
        if(inviteQr==null)return;
        inviteQr.setImageDrawable(null);
        inviteQr.setVisibility(View.GONE);
        inviteInfo.setText("QR이 만료됐어요. 주차 중 새 QR을 열 수 있어요.");
        if(room!=null&&room.optString("roomId").equals(inviteRoomId)) {
            if(cleanVehicleUi())inviteAfterJourneyStart=true;
            requestPhoneInvite();
        }
    };
    private String localSeat="FRONT_PASSENGER";
    private final AtomicLong reportCounter=new AtomicLong();
    private final Runnable reporter = new Runnable() { public void run() { if(isCar()){sendVehicle();onVehicleDemoTick();}main.postDelayed(this,2000); } };
    protected abstract boolean isCar();
    protected void onVehicleForegroundChanged(boolean value) {}
    protected void onVehicleDemoTick() {}
    protected void onGameVisibilityChanged() {}
    protected void hideVehicleRoundControls() {
        if (gamePanel != null) gamePanel.setVisibility(View.GONE);
    }
    protected RoomClient retainedClient(){return null;}
    protected boolean retainClientOnDestroy(){return false;}
    protected void addVehicleControls(LinearLayout container) {}
    protected void addVehicleWelcomeActions(LinearLayout menu) {}
    protected android.graphics.drawable.Drawable vehicleCover() { return new RoadCover(); }
    private boolean inviteAfterJourneyStart;
    protected void inspectExtraDiagnostics() {}
    protected void addPhoneCollectionContent(LinearLayout container) {}
    protected void onRoomData(JSONObject room) {}
    protected void onAdditionalTestAction(String action,String spawnId) {}

    protected final boolean showVehicleDiagnostics() {
        return isCar() && (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0
                && getIntent().getBooleanExtra("vehicleDiagnostics", false);
    }

    private boolean cleanVehicleUi() { return isCar() && !showVehicleDiagnostics(); }

    private String seatLabel(String seat) {
        switch (seat) {
            case "DRIVER": return "운전석";
            case "FRONT_PASSENGER": return "조수석";
            case "REAR_LEFT": return "뒷좌석 왼쪽";
            case "REAR_RIGHT": return "뒷좌석 오른쪽";
            default: return "좌석 미정";
        }
    }

    protected final int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    protected final void showVehicleLobby(boolean visible) {
        if (lobby == null) return;
        int visibility = visible && connected && foreground && localAllowed ? View.VISIBLE : View.GONE;
        lobby.setVisibility(visibility);
        roomLabel.setVisibility(visibility);
    }

    private LinearLayout lobbyCard() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(24), dp(18), dp(24), dp(18));
        styleVehicleCard(card, 0xff171a29);
        return card;
    }

    private void addLobbyCard(LinearLayout row, LinearLayout card, boolean wide, boolean second) {
        LinearLayout.LayoutParams params = wide
                ? new LinearLayout.LayoutParams(0, -2, 1)
                : new LinearLayout.LayoutParams(-1, -2);
        if (second) {
            if (wide) params.setMarginStart(dp(12));
            else params.topMargin = dp(12);
        }
        row.addView(card, params);
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        gameAudio=new GameAudio(this,message->event("audio",newJSONObject("message",message)));
        getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setPadding(dp(20),dp(14),dp(20),dp(14));root.setBackgroundColor(cleanVehicleUi()?0xff0b0d16:Color.rgb(15,24,33));root.setFocusableInTouchMode(true);root.requestFocus();
        ScrollView scroll=new ScrollView(this);scroll.setFillViewport(cleanVehicleUi());scroll.addView(root);setContentView(scroll);
        TextView title=text(cleanVehicleUi()?"Z-RIDE":isCar()?"Z-RIDE · 차량 파티":"Z-RIDE · 좌석별 사격",cleanVehicleUi()?36:23);
        if (cleanVehicleUi()) {
            LinearLayout masthead = new LinearLayout(this);
            masthead.setOrientation(LinearLayout.VERTICAL);
            masthead.setGravity(android.view.Gravity.CENTER_VERTICAL | android.view.Gravity.START);
            masthead.setMinimumHeight(dp(380));
            masthead.setPadding(dp(52), dp(24), dp(32), dp(24));
            masthead.setBackground(vehicleCover());
            scroll.addOnLayoutChangeListener((view,left,top,right,bottom,oldLeft,oldTop,oldRight,oldBottom)->{
                int height = Math.max(dp(380), bottom - top - root.getPaddingTop()
                        - root.getPaddingBottom() - dp(72));
                if (masthead.getMinimumHeight() != height) masthead.setMinimumHeight(height);
            });
            title.setTypeface(android.graphics.Typeface.create("sans-serif-black", android.graphics.Typeface.ITALIC));
            title.setTextSize(78);
            title.setTextColor(0xfff5f7ff);
            masthead.addView(title);
            vehicleMasthead = masthead;
            root.addView(masthead);
        } else {
            root.addView(title);
        }
        if(!cleanVehicleUi())root.addView(text("주차 중 협동 플레이",13));
        serverInput=edit("서버 URL",getIntent().getStringExtra("serverUrl") == null?(cleanVehicleUi()?"https://hyundai.hjpark.net":"http://10.0.2.2:8000"):getIntent().getStringExtra("serverUrl"));if(!cleanVehicleUi())root.addView(serverInput);
        nicknameInput=edit("닉네임",getIntent().getStringExtra("nickname")==null?(isCar()?"차량 관제":"대원 1"):getIntent().getStringExtra("nickname"));if(!cleanVehicleUi())root.addView(nicknameInput);
        accessKeyInput=edit(cleanVehicleUi()?"팀 접속 코드":"팀 테스트 접근키 · 로컬 서버는 생략","");accessKeyInput.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);accessKeyInput.setSaveEnabled(false);accessKeyInput.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);root.addView(accessKeyInput);if(cleanVehicleUi())accessKeyInput.setVisibility(View.GONE);
        if(!isCar()){
            codeInput=edit("차량 참가 코드",getIntent().getStringExtra("joinCode")==null?"":getIntent().getStringExtra("joinCode"));root.addView(codeInput);
            seats=new Spinner(this);String[] options={"FRONT_PASSENGER","REAR_LEFT","REAR_RIGHT"};seats.setAdapter(new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,options));
            String preset=getIntent().getStringExtra("seat");for(int i=0;i<options.length;i++)if(options[i].equals(preset))seats.setSelection(i);root.addView(seats);
        }
        if (cleanVehicleUi()) {
            partyWelcome = new LinearLayout(this);
            partyWelcome.setOrientation(LinearLayout.VERTICAL);
            LinearLayout.LayoutParams menu = new LinearLayout.LayoutParams(dp(384), -2);
            menu.topMargin = dp(22);
            ((LinearLayout) vehicleMasthead).addView(partyWelcome, menu);
            vehicleMasthead.addOnLayoutChangeListener((view, left, top, right, bottom,
                                                       oldLeft, oldTop, oldRight, oldBottom) -> {
                int width = Math.min(dp(384), right - left - view.getPaddingLeft() - view.getPaddingRight());
                if (width > 0 && menu.width != width) {
                    menu.width = width;
                    partyWelcome.setLayoutParams(menu);
                }
            });
            addVehicleWelcomeActions(partyWelcome);
            parkedHint = text("주차하면 파티를 시작할 수 있어요", 26);
            parkedHint.setTypeface(null, android.graphics.Typeface.BOLD);
            root.addView(parkedHint);
        }
        connectButton=button(cleanVehicleUi()?"여정 시작  ›":isCar()?"서버 연결 · 방 만들기":"서버 연결 · 참가 요청",v->{inviteAfterJourneyStart=cleanVehicleUi();connectRoom();});
        if (partyWelcome == null) root.addView(connectButton);
        else {
            LinearLayout.LayoutParams action = new LinearLayout.LayoutParams(-1, dp(62));
            action.topMargin = dp(12);
            partyWelcome.addView(connectButton, action);
        }
        status=text(cleanVehicleUi()?"":"연결 전",16);root.addView(status);
        roomLabel=text(cleanVehicleUi()?"동승자 합류":"ROOM —",cleanVehicleUi()?30:18);root.addView(roomLabel);
        if (cleanVehicleUi()) roomLabel.setTypeface(null, android.graphics.Typeface.BOLD);
        LinearLayout inviteContainer=root, rosterContainer=root;
        if(cleanVehicleUi()){
            lobby=new LinearLayout(this);
            boolean wide=getResources().getConfiguration().screenWidthDp>=640;
            lobby.setOrientation(wide?LinearLayout.HORIZONTAL:LinearLayout.VERTICAL);
            root.addView(lobby);
            inviteContainer=lobbyCard();
            rosterContainer=lobbyCard();
            addLobbyCard(lobby,inviteContainer,wide,false);
            addLobbyCard(lobby,rosterContainer,wide,true);
            TextView inviteTitle = text("동승자 초대", 26);
            inviteTitle.setTypeface(null, android.graphics.Typeface.BOLD);
            inviteContainer.addView(inviteTitle);
            TextView rosterTitle = text("참가 좌석", 26);
            rosterTitle.setTypeface(null, android.graphics.Typeface.BOLD);
            rosterContainer.addView(rosterTitle);
        }
        if(isCar()){
            inviteButton=button(cleanVehicleUi()?"새 QR 발급":"폰 초대 QR 발급",v->requestPhoneInvite());
            inviteInfo=text(cleanVehicleUi()?"휴대폰 카메라로 QR을 스캔하세요.":"서버 연결 후 주차 상태에서 QR을 발급합니다 · 폰 로그인 후 차량 승인",cleanVehicleUi()?18:14);inviteContainer.addView(inviteInfo);
            inviteQr=new ImageView(this);inviteQr.setContentDescription("동승자 초대 QR");inviteQr.setBackgroundColor(Color.WHITE);inviteQr.setVisibility(View.GONE);int qrSize=cleanVehicleUi()?dp(240):512;
            LinearLayout.LayoutParams qrParams=new LinearLayout.LayoutParams(qrSize,qrSize);
            qrParams.gravity=android.view.Gravity.CENTER_HORIZONTAL;
            inviteContainer.addView(inviteQr,qrParams);
            inviteContainer.addView(inviteButton);
        }
        memberLabel=text("",cleanVehicleUi()?18:13);
        if (cleanVehicleUi()) memberLabel.setLineSpacing(dp(8), 1f);
        rosterContainer.addView(memberLabel);
        approvals=new LinearLayout(this);approvals.setOrientation(LinearLayout.VERTICAL);rosterContainer.addView(approvals);
        if(!isCar()){
            collectionPanel=new LinearLayout(this);collectionPanel.setOrientation(LinearLayout.VERTICAL);root.addView(collectionPanel);
            collectionPanel.addView(text("동승자 독립 수집 · 전투는 주차 후",18));
            collectionPanel.addView(text("테스트 수집 지점 · GPS 미검증",15));
            addPhoneCollectionContent(collectionPanel);
            passengerConfirmation=new CheckBox(this);passengerConfirmation.setText("운전자가 아니며 동승자입니다");passengerConfirmation.setTextColor(Color.WHITE);passengerConfirmation.setChecked(false);passengerConfirmation.setOnCheckedChangeListener((v,checked)->{if(room!=null)refreshCollection(room);});collectionPanel.addView(passengerConfirmation);
            collectionSummary=text("차량 승인 대기 · 보급품 0",14);collectionPanel.addView(collectionSummary);
            collectionFixtures=new LinearLayout(this);collectionFixtures.setOrientation(LinearLayout.VERTICAL);collectionPanel.addView(collectionFixtures);
        }
        diagnostics=text(isCar()?"차량 서비스 연결 대기":"좌석은 차량 화면의 승인이 필요합니다.",12);diagnostics.setTextIsSelectable(true);if(!cleanVehicleUi())root.addView(diagnostics);
        if(isCar())addVehicleControls(root);
        if(showVehicleDiagnostics()){extraDiagnostics=text("추가 차량 API 진단 대기",12);extraDiagnostics.setTextIsSelectable(true);extraDiagnostics.setVisibility(View.GONE);root.addView(button("추가 진단 결과 펼치기 / 접기",v->extraDiagnostics.setVisibility(extraDiagnostics.getVisibility()==View.VISIBLE?View.GONE:View.VISIBLE)));root.addView(extraDiagnostics);}
        statsLabel=text("SHOTS 0 · HITS 0 · KILLS 0",14);if(!cleanVehicleUi())root.addView(statsLabel);
        gamePanel=new LinearLayout(this);gamePanel.setOrientation(LinearLayout.VERTICAL);root.addView(gamePanel);
        arena=new SeatArenaView(this);if(!cleanVehicleUi())gamePanel.addView(arena,new LinearLayout.LayoutParams(-1,360));arena.setAimListener(a->sendAction("fire",a));
        soundToggle=new CheckBox(this);soundToggle.setText("게임 효과음 켜기 · 기본 오디오 출력");soundToggle.setTextColor(Color.WHITE);soundToggle.setChecked(false);soundToggle.setOnCheckedChangeListener((view,checked)->{gameAudio.setEnabled(checked);updateGameVisibility();});if(!cleanVehicleUi())gamePanel.addView(soundToggle);
        if(!cleanVehicleUi())gamePanel.addView(text("효과음 크기 · 앱 내 최대 15% / 차량 전체 음량은 변경하지 않음",11));
        SeekBar gain=new SeekBar(this);gain.setMax(15);gain.setProgress(6);gain.setContentDescription("게임 효과음 크기");gain.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener(){public void onProgressChanged(SeekBar bar,int progress,boolean fromUser){gameAudio.setGain(progress/100f);}public void onStartTrackingTouch(SeekBar bar){}public void onStopTrackingTouch(SeekBar bar){}});if(!cleanVehicleUi())gamePanel.addView(gain);
        LinearLayout actions=new LinearLayout(this);gamePanel.addView(actions);
        if(isCar()){
            actions.addView(button("라운드 시작",v->sendAction("round.start",null)),new LinearLayout.LayoutParams(0,-2,1));
            if(!cleanVehicleUi())actions.addView(button("지원 · 보급품 1개 사용",v->sendAction("support.pulse",null)),new LinearLayout.LayoutParams(0,-2,1));
            actions.addView(button("중지",v->sendAction("round.pause",null)),new LinearLayout.LayoutParams(0,-2,1));
        } else {
            for(int angle:new int[]{-135,0,90,135}){Button fire=button(angle+"°",v->{arena.setAim(angle);sendAction("fire",(float)angle);});fireButtons.add(fire);actions.addView(fire,new LinearLayout.LayoutParams(0,-2,1));}
        }
        resultLabel=text("서버 판정 대기",14);if(!cleanVehicleUi())root.addView(resultLabel);
        if(!cleanVehicleUi())root.addView(text("색 영역 = 좌석 사격각. 그림은 상대각 시연용이며 서버가 각도·좌석·주차 조건을 판정합니다.",12));
        client=retainedClient();if(client==null)client=new RoomClient(this);else client.setListener(this);refreshEnrollmentConfig();updateGameVisibility();
        DebugCommandReceiver.attach(this);
        if(localDebugAutomation()&&getIntent().getBooleanExtra("autoConnect",false)&&!"connect".equals(getIntent().getStringExtra("testAction")))main.postDelayed(this::connectRoom,800);
        acceptTestIntent(getIntent());
    }
    private TextView text(String value,int size){TextView t=new TextView(this);t.setText(value);t.setTextColor(Color.rgb(228,237,242));t.setTextSize(size);t.setPadding(0,5,0,5);return t;}
    private EditText edit(String hint,String value){EditText e=new EditText(this);e.setSingleLine(true);e.setTextColor(Color.WHITE);e.setHintTextColor(Color.GRAY);e.setHint(hint);e.setContentDescription(hint);e.setText(value);return e;}
    protected final void styleVehicleCard(View view, int color) {
        android.graphics.drawable.GradientDrawable background = new android.graphics.drawable.GradientDrawable();
        background.setColor(color);
        background.setCornerRadius(dp(18));
        view.setBackground(background);
    }

    protected final void styleVehicleButton(Button button) {
        styleVehicleButton(button, true);
    }

    protected final void styleVehicleButton(Button button, boolean primary) {
        if (!cleanVehicleUi()) return;
        button.setAllCaps(false);
        button.setMinHeight(dp(56));
        button.setTextSize(18);
        int[][] states = {{-android.R.attr.state_enabled}, {}};
        button.setTextColor(new android.content.res.ColorStateList(states,
                new int[]{0xffa6aabe, primary ? 0xff101323 : 0xffe3e6ff}));
        android.graphics.drawable.GradientDrawable surface = new android.graphics.drawable.GradientDrawable();
        surface.setCornerRadius(dp(14));
        surface.setColor(new android.content.res.ColorStateList(states,
                new int[]{0xff292d43, primary ? 0xffb5bcff : 0xff292d48}));
        button.setBackground(new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(primary ? 0x33082928 : 0x3374e1cc), surface, null));
        button.setPadding(dp(16), dp(8), dp(16), dp(8));
        LinearLayout.LayoutParams spacing = new LinearLayout.LayoutParams(-1, -2);
        spacing.topMargin = dp(8);
        button.setLayoutParams(spacing);
    }

    private Button button(String title,View.OnClickListener action){Button b=new Button(this);b.setText(title);styleVehicleButton(b);b.setContentDescription(title);b.setOnClickListener(action);return b;}
    private void refreshEnrollmentConfig(){client.getPublicConfig(serverInput.getText().toString().trim(),new RoomClient.ApiCallback(){public void onResponse(JSONObject value){main.post(()->{accessKeyInput.setVisibility(value.optBoolean("sessionAccessKeyRequired",true)?View.VISIBLE:View.GONE);});}public void onError(String error){}});}
    private void connectRoom(){((android.view.inputmethod.InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(serverInput.getWindowToken(),0);client.close();connected=false;sawRoom=false;lastShotTime=0;reportCounter.set(0);localSeat=isCar()?"DRIVER":seats.getSelectedItem().toString();String accessKey=accessKeyInput.getText().toString();accessKeyInput.setText("");client.connect(serverInput.getText().toString().trim(),isCar(),nicknameInput.getText().toString().trim(),isCar()?"":codeInput.getText().toString(),localSeat,accessKey);}
    @Override protected void onResume(){super.onResume();DebugCommandReceiver.attach(this);foreground=true;onVehicleForegroundChanged(true);main.post(reporter);}
    @Override protected void onPause(){foreground=false;onVehicleForegroundChanged(false);if(isCar())sendVehicle();main.removeCallbacks(reporter);localAllowed=false;updateGameVisibility();super.onPause();}
    @Override protected void onDestroy(){DebugCommandReceiver.detach(this);if(accessKeyInput!=null)accessKeyInput.setText("");main.removeCallbacks(expireInvite);main.removeCallbacks(reporter);main.removeCallbacks(testRunner);if(gameAudio!=null)gameAudio.close();if(!retainClientOnDestroy())client.destroy();super.onDestroy();}
    private void requestPhoneInvite(){
        if(!isCar()||!connected||!foreground||!localAllowed||room==null)return;
        if(cleanVehicleUi()&&inviteSeatCount(false)>=3)return;
        final String requested=room.optString("roomId");
        if(requested.equals(invitePendingRoomId))return;
        inviteAfterJourneyStart=false;
        invitePendingRoomId=requested;
        inviteButton.setEnabled(false);
        if(cleanVehicleUi()&&inviteQr.getDrawable()==null)inviteInfo.setText("초대 QR을 만드는 중…");
        client.postApi("/api/rooms/"+requested+"/party/invite",new JSONObject(),new RoomClient.ApiCallback(){
            public void onResponse(JSONObject value){main.post(()->{if(!finishInviteRequest(requested))return;try{
                long ttl=value.getLong("expiresAt")-System.currentTimeMillis();if(ttl<=0)throw new IllegalStateException("초대 시간이 만료됨");
                BitMatrix bits=new MultiFormatWriter().encode(value.getString("joinUrl"),BarcodeFormat.QR_CODE,512,512);
                Bitmap bitmap=Bitmap.createBitmap(512,512,Bitmap.Config.ARGB_8888);int[] pixels=new int[512*512];
                for(int y=0;y<512;y++)for(int x=0;x<512;x++)pixels[y*512+x]=bits.get(x,y)?Color.BLACK:Color.WHITE;
                bitmap.setPixels(pixels,0,512,0,0,512,512);inviteRoomId=requested;inviteQr.setImageBitmap(bitmap);inviteQr.setVisibility(View.VISIBLE);inviteInfo.setText("휴대폰으로 QR을 스캔하고 좌석을 선택하세요.");main.removeCallbacks(expireInvite);main.postDelayed(expireInvite,ttl);
            }catch(Exception e){inviteInfo.setText("QR 발급 실패 · 다시 발급해 주세요");}updateGameVisibility();});}
            public void onError(String error){main.post(()->{if(!finishInviteRequest(requested))return;inviteInfo.setText("QR 발급 실패 · 서버 연결을 확인해 주세요");updateGameVisibility();});}
        });
    }
    private boolean finishInviteRequest(String requested){
        if(!requested.equals(invitePendingRoomId))return false;
        invitePendingRoomId=null;
        return room!=null&&requested.equals(room.optString("roomId"));
    }
    private int inviteSeatCount(boolean pendingOnly){
        JSONArray members=room==null?null:room.optJSONArray("members");
        if(members==null)return 0;
        int count=0;
        for(int i=0;i<members.length();i++){
            JSONObject member=members.optJSONObject(i);
            if(member==null||(pendingOnly&&member.optBoolean("approved")))continue;
            String seat=member.optString("seat");
            if("FRONT_PASSENGER".equals(seat)||"REAR_LEFT".equals(seat)||"REAR_RIGHT".equals(seat))count++;
        }
        return count;
    }
    private void updateInviteUi(){
        if(inviteButton==null)return;
        boolean parked=foreground&&localAllowed;
        String id=room==null?"":room.optString("roomId");
        if(inviteRoomId!=null&&!inviteRoomId.equals(id)){
            main.removeCallbacks(expireInvite);
            inviteQr.setImageDrawable(null);
            inviteRoomId=null;
        }
        boolean full=cleanVehicleUi()&&inviteSeatCount(false)>=3;
        if(cleanVehicleUi()){
            lobby.setVisibility(connected&&parked?View.VISIBLE:View.GONE);
            connectButton.setVisibility(!connected&&parked?View.VISIBLE:View.GONE);
            inviteInfo.setVisibility(connected&&parked?View.VISIBLE:View.GONE);
            if(full){
                main.removeCallbacks(expireInvite);
                inviteQr.setImageDrawable(null);
                inviteRoomId=null;
                inviteAfterJourneyStart=true;
                int pending=inviteSeatCount(true);
                inviteInfo.setText(pending==0?"동승자 3명이 함께해요.":"동승자 "+pending+"명의 참가 요청을 승인해 주세요.");
            }
        }
        inviteButton.setEnabled(connected&&parked&&!full&&!id.equals(invitePendingRoomId));
        inviteButton.setVisibility(parked&&(!cleanVehicleUi()||connected)&&!full?View.VISIBLE:View.GONE);
        inviteQr.setVisibility(connected&&parked&&!full&&inviteQr.getDrawable()!=null?View.VISIBLE:View.GONE);
    }
    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);acceptTestIntent(intent);}
    final void receiveDebugCommand(Intent intent){main.post(()->acceptTestIntent(intent));}
    public void onStatus(String value){main.post(()->status.setText(!cleanVehicleUi()?value:value.startsWith("Connected")?"파티 연결됨":value.startsWith("Connecting")?"파티에 연결하는 중":"파티 연결 상태를 확인해 주세요"));event("connection",newJSONObject("message",value));}
    public void onDisconnected(){main.post(()->{connected=false;updateGameVisibility();});}
    public void onRoom(JSONObject value){main.post(()->{connected=true;room=value;updateGameVisibility();roomLabel.setText(cleanVehicleUi()?"동승자 합류":"ROOM "+value.optString("roomId")+"  CODE "+value.optString("joinCode","—")+"  "+value.optString("state"));
        JSONArray members=value.optJSONArray("members");StringBuilder label=new StringBuilder(),pending=new StringBuilder();
        if(isCar()&&members!=null)for(int i=0;i<members.length();i++){JSONObject m=members.optJSONObject(i);if(m!=null&&!m.optBoolean("approved"))pending.append(m.optString("memberId")).append('|').append(m.optString("seat")).append('|').append(m.optString("nickname")).append('\n');}
        String nextApprovals=value.optString("roomId")+":"+pending;boolean refreshApprovals=!nextApprovals.equals(approvalSignature);
        if(refreshApprovals){approvals.removeAllViews();approvalSignature=nextApprovals;}
        if(members!=null)for(int i=0;i<members.length();i++){JSONObject m=members.optJSONObject(i);if(m==null)continue;if(!isCar()&&m.optString("sessionId").equals(client.getSessionId()))localSeat=m.optString("seat",localSeat);
            if (cleanVehicleUi() && "DRIVER".equals(m.optString("seat"))) continue;
            label.append(m.optString("nickname")).append(" · ");
            if(cleanVehicleUi())label.append(seatLabel(m.optString("seat")));
            else label.append(m.optString("role")).append(" / ").append(m.optString("seatEvidence"));
            label.append(m.optBoolean("approved")?" · 참가 완료":" · 승인 대기").append("\n");
            if(isCar()&&refreshApprovals&&!m.optBoolean("approved")){final String id=m.optString("memberId"),seat=m.optString("seat");approvals.addView(button(m.optString("nickname")+" · "+(cleanVehicleUi()?seatLabel(seat):seat)+" 승인",v->client.approve(id,seat)));}}
        JSONObject stats=value.optJSONObject("stats");if(stats!=null){JSONObject collection=value.optJSONObject("collection");JSONObject inventory=collection==null?null:collection.optJSONObject("inventory");statsLabel.setText("SHOTS "+stats.optInt("shots")+" · HITS "+stats.optInt("hits")+" · KILLS "+stats.optInt("kills")+" · SUPPLIES "+(inventory==null?0:inventory.optInt("supplies"))+(stats.optBoolean("supportActive")?" · SUPPORT ×"+stats.optInt("supportDamage",2):""));JSONObject shot=stats.optJSONObject("lastShot");if(shot!=null){long time=shot.optLong("time");if(sawRoom&&time>lastShotTime&&shot.optBoolean("accepted"))gameAudio.feedback(shot.optBoolean("hit"));lastShotTime=Math.max(lastShotTime,time);}}sawRoom=true;
        if(!isCar())refreshCollection(value);
        memberLabel.setText(cleanVehicleUi() && label.length() == 0
                ? "아직 참가한 동승자가 없어요.\nQR을 보여주고 함께 시작하세요."
                : label.toString().trim());arena.setRoom(value);updateGameVisibility();onRoomData(value);});
        event("snapshot",summary(value));
        // Debug APK private state enables adb run-as verification without logging join secrets.
        try(FileWriter file=new FileWriter(new File(getFilesDir(),"room-state.json"),false)){file.write(value.toString(2));}catch(Exception ignored){}
    }
    private JSONObject summary(JSONObject value){JSONObject x=new JSONObject();try{x.put("roomId",value.optString("roomId")).put("state",value.optString("state")).put("roomEpoch",value.optLong("roomEpoch")).put("vehicle",value.optJSONObject("vehicle")).put("members",value.optJSONArray("members"));}catch(Exception ignored){}return x;}
    public void onResult(JSONObject value){main.post(()->resultLabel.setText(value.toString()));String action=pendingCommands.remove(value.optString("commandId"));if(action!=null){try{JSONObject receipt=new JSONObject(value.toString()).put("requestedAction",action);writePrivate("last-action-result.json",receipt);}catch(Exception ignored){}}event("server.result",value);}
    protected void applyVehicle(JSONObject value,boolean allowed){latestVehicle=value;localAllowed=allowed&&foreground;main.post(()->{diagnostics.setText(value.toString());updateGameVisibility();});if(foreground)sendVehicle();}

    private void updateVehicleWelcome() {
        if (partyWelcome == null) return;
        vehicleMasthead.setVisibility(foreground && localAllowed && !connected ? View.VISIBLE : View.GONE);
        partyWelcome.setVisibility(foreground && localAllowed && !connected ? View.VISIBLE : View.GONE);
        parkedHint.setVisibility(foreground && !localAllowed ? View.VISIBLE : View.GONE);
        String gear = latestVehicle.optString("gear", "UNKNOWN");
        String restrictions = latestVehicle.optString("ux", "UNKNOWN");
        parkedHint.setText("UNKNOWN".equals(gear) || "UNKNOWN".equals(restrictions)
                ? "차량 상태를 확인하는 중이에요" : "주차 후 플레이할 수 있어요");
        status.setVisibility(foreground && localAllowed ? View.VISIBLE : View.GONE);
        if (inviteAfterJourneyStart && connected && client.isAuthenticated()) requestPhoneInvite();
    }
    protected void applyExtraDiagnostics(JSONObject value){writePrivate("cabin-state.json",value);main.post(()->{if(extraDiagnostics!=null)try{extraDiagnostics.setText(value.toString(2));}catch(Exception ignored){}});}
    protected final void updateGameVisibility(){updateVehicleWelcome();updateInviteUi();if(gamePanel==null)return;boolean show=!isCar()||(localAllowed&&foreground);gamePanel.setVisibility(show&&!cleanVehicleUi()?View.VISIBLE:View.GONE);if(isCar()){roomLabel.setVisibility(show&&(!cleanVehicleUi()||connected)?View.VISIBLE:View.GONE);memberLabel.setVisibility(show&&(!cleanVehicleUi()||connected)?View.VISIBLE:View.GONE);statsLabel.setVisibility(show?View.VISIBLE:View.GONE);approvals.setVisibility(show?View.VISIBLE:View.GONE);}else{int setup=connected?View.GONE:View.VISIBLE;serverInput.setVisibility(setup);nicknameInput.setVisibility(setup);accessKeyInput.setVisibility(setup);if(codeInput!=null)codeInput.setVisibility(setup);if(seats!=null)seats.setVisibility(setup);connectButton.setVisibility(setup);}String state=room==null?"WAITING":room.optString("state");boolean active=connected&&foreground&&"PLAYING".equals(state)&&(!isCar()||localAllowed);arena.update(localSeat,state,active);for(Button b:fireButtons)b.setEnabled(active);if(gameAudio!=null)gameAudio.setAllowed(active);if(!isCar()&&room!=null)refreshCollection(room);onGameVisibilityChanged();}
    protected void sendVehicle(){if(!isCar()||!connected||client==null)return;try{JSONObject message=new JSONObject(latestVehicle.toString());message.put("type","vehicle.report").put("commandId",UUID.randomUUID().toString()).put("reportSeq",client.nextVehicleReportSequence()).put("foreground",foreground);client.send(message);}catch(Exception e){event("report.error",newJSONObject("message",e.toString()));}}
    private void sendAction(String action,Float angle){sendAction(action,angle,null);}
    private void sendAction(String action,Float angle,String pickupId){if(room==null)return;if(isCar()&&!localAllowed&&!action.equals("round.pause"))return;try{String id=UUID.randomUUID().toString();JSONObject msg=new JSONObject().put("type","command").put("commandId",id).put("roomEpoch",room.optLong("roomEpoch")).put("action",action);if(angle!=null)msg.put("angleDeg",angle);if(pickupId!=null)msg.put("pickupId",pickupId).put("passengerConfirmed",passengerConfirmation!=null&&passengerConfirmation.isChecked());if(pendingCommands.size()>256)pendingCommands.clear();pendingCommands.put(id,action);if(!client.send(msg))pendingCommands.remove(id);}catch(Exception ignored){}}
    private void refreshCollection(JSONObject value){
        if(collectionPanel==null||collectionFixtures==null)return;passengerApproved=false;
        JSONArray members=value.optJSONArray("members");if(members!=null)for(int i=0;i<members.length();i++){JSONObject m=members.optJSONObject(i);if(m!=null&&m.optString("sessionId").equals(client==null?"":client.getSessionId()))passengerApproved=m.optBoolean("approved")&&!m.optString("role").equals("CAR_HOST")&&!m.optString("seat").equals("DRIVER");}
        JSONObject collection=value.optJSONObject("collection"),inventory=collection==null?null:collection.optJSONObject("inventory");
        collectionSummary.setText((passengerApproved?"동승자 승인됨":"차량 승인 대기")+" · 공동 보급품 "+(inventory==null?0:inventory.optInt("supplies"))+" · 전투 상태와 별개");
        collectionFixtures.removeAllViews();if(collection==null)return;
        JSONArray fixtures=collection.optJSONArray("fixtures"),collected=collection.optJSONArray("collectedPickupIds");if(fixtures==null)return;
        for(int i=0;i<fixtures.length();i++){JSONObject fixture=fixtures.optJSONObject(i);if(fixture==null)continue;String id=fixture.optString("pickupId");boolean done=false;if(collected!=null)for(int j=0;j<collected.length();j++)if(id.equals(collected.optString(j)))done=true;
            Button collect=button((done?"수집 완료 · ":"수집 · ")+fixture.optString("title",id),v->sendAction("mobile.collect",null,id));collect.setEnabled(connected&&foreground&&passengerApproved&&passengerConfirmation.isChecked()&&!done);collectionFixtures.addView(collect);
        }
    }
    private void acceptTestIntent(Intent intent){
        String action=intent.getStringExtra("testAction");if(action==null)return;
        if(!localDebugAutomation()){event("test.rejected",newJSONObject("reason","debug build and local server required"));return;}
        if(!java.util.Arrays.asList("connect","approvePending","roundStart","roundPause","fire","supportPulse","inspectCabin","soundOn","soundOff","collect","mapRefresh","mapSnapshot","gpsRefresh","mapFocusGPS","worldClaim").contains(action)){event("test.rejected",newJSONObject("reason","unknown action"));return;}
        pendingTestAction=action;pendingTestAngle=intent.getFloatExtra("testAngleDeg",60);pendingPickupId=intent.getStringExtra("pickupId");pendingSpawnId=intent.getStringExtra("spawnId");pendingPassengerConfirmation=intent.getBooleanExtra("passengerConfirmed",false);testDeadline=SystemClock.elapsedRealtime()+15000;main.removeCallbacks(testRunner);main.postDelayed(testRunner,200);
    }
    private boolean localDebugAutomation(){String host=Uri.parse(serverInput.getText().toString()).getHost();return (getApplicationInfo().flags&ApplicationInfo.FLAG_DEBUGGABLE)!=0&&("127.0.0.1".equals(host)||"localhost".equals(host)||"10.0.2.2".equals(host));}
    private void runTestAction(){
        String action=pendingTestAction;if(action==null)return;
        boolean ready=foreground;
        if(!java.util.Arrays.asList("connect","inspectCabin","mapSnapshot","gpsRefresh","mapFocusGPS").contains(action))ready=ready&&connected&&room!=null;
        if(isCar()&&!action.equals("connect")&&!action.equals("inspectCabin")&&!action.equals("roundPause"))ready=ready&&localAllowed;
        if(!ready){if(SystemClock.elapsedRealtime()<testDeadline){main.postDelayed(testRunner,500);return;}pendingTestAction=null;event("test.rejected",newJSONObject("reason",action+": current real gate/connection not ready"));return;}
        pendingTestAction=null;event("test.executed",newJSONObject("action",action));
        switch(action){
            case "connect":connectRoom();break;
            case "inspectCabin":inspectExtraDiagnostics();break;
            case "approvePending":if(isCar()){JSONArray members=room.optJSONArray("members");if(members!=null)for(int i=0;i<members.length();i++){JSONObject m=members.optJSONObject(i);if(m!=null&&!m.optBoolean("approved"))client.approve(m.optString("memberId"),m.optString("seat"));}}break;
            case "roundStart":sendVehicle();sendAction("round.start",null);break;
            case "roundPause":sendAction("round.pause",null);break;
            case "fire":sendAction("fire",pendingTestAngle);break;
            case "supportPulse":sendAction("support.pulse",null);break;
            case "soundOn":soundToggle.setChecked(true);break;
            case "soundOff":soundToggle.setChecked(false);break;
            case "collect":if(!isCar()&&pendingPassengerConfirmation&&pendingPickupId!=null){passengerConfirmation.setChecked(true);sendAction("mobile.collect",null,pendingPickupId);}else event("test.rejected",newJSONObject("reason","explicit passengerConfirmed and pickupId required"));break;
            case "mapRefresh":case "mapSnapshot":case "gpsRefresh":case "mapFocusGPS":case "worldClaim":if(!isCar()){if(pendingPassengerConfirmation&&passengerConfirmation!=null)passengerConfirmation.setChecked(true);onAdditionalTestAction(action,pendingSpawnId);}break;
        }
    }
    private void writePrivate(String name,JSONObject value){try(FileWriter file=new FileWriter(new File(getFilesDir(),name),false)){file.write(value.toString(2));}catch(Exception ignored){}}
    protected final boolean passengerConfirmed(){return passengerConfirmation!=null&&passengerConfirmation.isChecked();}
    protected static JSONObject newJSONObject(String k,Object v){JSONObject x=new JSONObject();try{x.put(k,v);}catch(Exception ignored){}return x;}
    protected void event(String type,JSONObject data){try{JSONObject line=new JSONObject().put("event",type).put("time",System.currentTimeMillis()).put("data",data);Log.i("ZRideDiag",line.toString());synchronized(DemoActivity.class){try(FileWriter f=new FileWriter(new File(getFilesDir(),"diagnostics.jsonl"),true)){f.write(line+"\n");}}}catch(Exception ignored){}}
}
