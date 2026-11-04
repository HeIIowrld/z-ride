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
    private LinearLayout approvals, gamePanel;
    private SeatArenaView arena;
    private ImageView inviteQr;
    private TextView inviteInfo;
    private Button inviteButton;
    private String inviteRoomId;
    private final Runnable expireInvite=()->{if(inviteQr!=null){inviteQr.setImageDrawable(null);inviteQr.setVisibility(View.GONE);inviteInfo.setText("QR 만료 · 주차 상태에서 새 QR을 갱신합니다");if(connected&&foreground&&localAllowed&&room!=null&&room.optString("roomId").equals(inviteRoomId))requestPhoneInvite();}};
    private String localSeat="FRONT_PASSENGER";
    private final AtomicLong reportCounter=new AtomicLong();
    private final Runnable reporter = new Runnable() { public void run() { if(isCar())sendVehicle();main.postDelayed(this,2000); } };
    protected abstract boolean isCar();
    protected void onVehicleForegroundChanged(boolean value) {}
    protected void addVehicleControls(LinearLayout container) {}
    protected void inspectExtraDiagnostics() {}
    protected void addPhoneCollectionContent(LinearLayout container) {}
    protected void onRoomData(JSONObject room) {}
    protected void onAdditionalTestAction(String action,String spawnId) {}

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        gameAudio=new GameAudio(this,message->event("audio",newJSONObject("message",message)));
        getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setPadding(20,14,20,14);root.setBackgroundColor(Color.rgb(15,24,33));root.setFocusableInTouchMode(true);root.requestFocus();
        ScrollView scroll=new ScrollView(this);scroll.addView(root);setContentView(scroll);
        TextView title=text(isCar()?"Z-RIDE · 차량 관제 / 신호 진단":"Z-RIDE · 좌석별 사격",23);root.addView(title);
        root.addView(text("주차 중 협동 통신 프로토타입 · 실제 차량 제어 없음",13));
        serverInput=edit("서버 URL",getIntent().getStringExtra("serverUrl") == null?"http://10.0.2.2:8000":getIntent().getStringExtra("serverUrl"));root.addView(serverInput);
        nicknameInput=edit("닉네임",getIntent().getStringExtra("nickname")==null?(isCar()?"차량 관제":"대원 1"):getIntent().getStringExtra("nickname"));root.addView(nicknameInput);
        accessKeyInput=edit("팀 테스트 접근키 · 로컬 서버는 생략","");accessKeyInput.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);accessKeyInput.setSaveEnabled(false);accessKeyInput.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);root.addView(accessKeyInput);
        if(!isCar()){
            codeInput=edit("차량 참가 코드",getIntent().getStringExtra("joinCode")==null?"":getIntent().getStringExtra("joinCode"));root.addView(codeInput);
            seats=new Spinner(this);String[] options={"FRONT_PASSENGER","REAR_LEFT","REAR_RIGHT"};seats.setAdapter(new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,options));
            String preset=getIntent().getStringExtra("seat");for(int i=0;i<options.length;i++)if(options[i].equals(preset))seats.setSelection(i);root.addView(seats);
        }
        connectButton=button(isCar()?"서버 연결 · 방 만들기":"서버 연결 · 참가 요청",v->connectRoom());root.addView(connectButton);
        status=text("연결 전",14);root.addView(status);roomLabel=text("ROOM —",18);root.addView(roomLabel);
        if(isCar()){
            inviteButton=button("폰 초대 QR 발급",v->requestPhoneInvite());root.addView(inviteButton);
            inviteInfo=text("서버 연결 후 주차 상태에서 QR을 발급합니다 · 폰 로그인 후 차량 승인",14);root.addView(inviteInfo);
            inviteQr=new ImageView(this);inviteQr.setContentDescription("폰 파티 참가 QR");inviteQr.setBackgroundColor(Color.WHITE);inviteQr.setVisibility(View.GONE);root.addView(inviteQr,new LinearLayout.LayoutParams(512,512));
        }
        memberLabel=text("",13);root.addView(memberLabel);
        approvals=new LinearLayout(this);approvals.setOrientation(LinearLayout.VERTICAL);root.addView(approvals);
        if(!isCar()){
            collectionPanel=new LinearLayout(this);collectionPanel.setOrientation(LinearLayout.VERTICAL);root.addView(collectionPanel);
            collectionPanel.addView(text("동승자 독립 수집 · 전투는 주차 후",18));
            collectionPanel.addView(text("테스트 수집 지점 · GPS 미검증",15));
            addPhoneCollectionContent(collectionPanel);
            passengerConfirmation=new CheckBox(this);passengerConfirmation.setText("운전자가 아니며 동승자입니다");passengerConfirmation.setTextColor(Color.WHITE);passengerConfirmation.setChecked(false);passengerConfirmation.setOnCheckedChangeListener((v,checked)->{if(room!=null)refreshCollection(room);});collectionPanel.addView(passengerConfirmation);
            collectionSummary=text("차량 승인 대기 · 보급품 0",14);collectionPanel.addView(collectionSummary);
            collectionFixtures=new LinearLayout(this);collectionFixtures.setOrientation(LinearLayout.VERTICAL);collectionPanel.addView(collectionFixtures);
        }
        diagnostics=text(isCar()?"차량 서비스 연결 대기":"좌석은 차량 화면의 승인이 필요합니다.",12);diagnostics.setTextIsSelectable(true);root.addView(diagnostics);
        if(isCar())addVehicleControls(root);
        if(isCar()){extraDiagnostics=text("추가 차량 API 진단 대기",12);extraDiagnostics.setTextIsSelectable(true);extraDiagnostics.setVisibility(View.GONE);root.addView(button("추가 진단 결과 펼치기 / 접기",v->extraDiagnostics.setVisibility(extraDiagnostics.getVisibility()==View.VISIBLE?View.GONE:View.VISIBLE)));root.addView(extraDiagnostics);}
        statsLabel=text("SHOTS 0 · HITS 0 · KILLS 0",14);root.addView(statsLabel);
        gamePanel=new LinearLayout(this);gamePanel.setOrientation(LinearLayout.VERTICAL);root.addView(gamePanel);
        arena=new SeatArenaView(this);gamePanel.addView(arena,new LinearLayout.LayoutParams(-1,360));arena.setAimListener(a->sendAction("fire",a));
        soundToggle=new CheckBox(this);soundToggle.setText("게임 효과음 켜기 · 기본 오디오 출력");soundToggle.setTextColor(Color.WHITE);soundToggle.setChecked(false);soundToggle.setOnCheckedChangeListener((view,checked)->{gameAudio.setEnabled(checked);updateGameVisibility();});gamePanel.addView(soundToggle);
        gamePanel.addView(text("효과음 크기 · 앱 내 최대 15% / 차량 전체 음량은 변경하지 않음",11));
        SeekBar gain=new SeekBar(this);gain.setMax(15);gain.setProgress(6);gain.setContentDescription("게임 효과음 크기");gain.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener(){public void onProgressChanged(SeekBar bar,int progress,boolean fromUser){gameAudio.setGain(progress/100f);}public void onStartTrackingTouch(SeekBar bar){}public void onStopTrackingTouch(SeekBar bar){}});gamePanel.addView(gain);
        LinearLayout actions=new LinearLayout(this);gamePanel.addView(actions);
        if(isCar()){
            actions.addView(button("라운드 시작",v->sendAction("round.start",null)),new LinearLayout.LayoutParams(0,-2,1));
            actions.addView(button("지원 · 보급품 1개 사용",v->sendAction("support.pulse",null)),new LinearLayout.LayoutParams(0,-2,1));
            actions.addView(button("중지",v->sendAction("round.pause",null)),new LinearLayout.LayoutParams(0,-2,1));
        } else {
            for(int angle:new int[]{-135,0,90,135}){Button fire=button(angle+"°",v->{arena.setAim(angle);sendAction("fire",(float)angle);});fireButtons.add(fire);actions.addView(fire,new LinearLayout.LayoutParams(0,-2,1));}
        }
        resultLabel=text("서버 판정 대기",14);root.addView(resultLabel);
        root.addView(text("색 영역 = 좌석 사격각. 그림은 상대각 시연용이며 서버가 각도·좌석·주차 조건을 판정합니다.",12));
        client=new RoomClient(this);refreshEnrollmentConfig();updateGameVisibility();
        DebugCommandReceiver.attach(this);
        if(localDebugAutomation()&&getIntent().getBooleanExtra("autoConnect",false)&&!"connect".equals(getIntent().getStringExtra("testAction")))main.postDelayed(this::connectRoom,800);
        acceptTestIntent(getIntent());
    }
    private TextView text(String value,int size){TextView t=new TextView(this);t.setText(value);t.setTextColor(Color.rgb(228,237,242));t.setTextSize(size);t.setPadding(0,5,0,5);return t;}
    private EditText edit(String hint,String value){EditText e=new EditText(this);e.setSingleLine(true);e.setTextColor(Color.WHITE);e.setHintTextColor(Color.GRAY);e.setHint(hint);e.setContentDescription(hint);e.setText(value);return e;}
    private Button button(String title,View.OnClickListener action){Button b=new Button(this);b.setText(title);b.setContentDescription(title);b.setOnClickListener(action);return b;}
    private void refreshEnrollmentConfig(){client.getPublicConfig(serverInput.getText().toString().trim(),new RoomClient.ApiCallback(){public void onResponse(JSONObject value){main.post(()->{accessKeyInput.setVisibility(value.optBoolean("sessionAccessKeyRequired",true)?View.VISIBLE:View.GONE);});}public void onError(String error){}});}
    private void connectRoom(){((android.view.inputmethod.InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(serverInput.getWindowToken(),0);client.close();connected=false;sawRoom=false;lastShotTime=0;reportCounter.set(0);localSeat=isCar()?"DRIVER":seats.getSelectedItem().toString();String accessKey=accessKeyInput.getText().toString();accessKeyInput.setText("");client.connect(serverInput.getText().toString().trim(),isCar(),nicknameInput.getText().toString().trim(),isCar()?"":codeInput.getText().toString(),localSeat,accessKey);}
    @Override protected void onResume(){super.onResume();DebugCommandReceiver.attach(this);foreground=true;onVehicleForegroundChanged(true);main.post(reporter);}
    @Override protected void onPause(){foreground=false;onVehicleForegroundChanged(false);if(isCar())sendVehicle();main.removeCallbacks(reporter);localAllowed=false;updateGameVisibility();super.onPause();}
    @Override protected void onDestroy(){DebugCommandReceiver.detach(this);if(accessKeyInput!=null)accessKeyInput.setText("");main.removeCallbacks(expireInvite);main.removeCallbacks(reporter);main.removeCallbacks(testRunner);if(gameAudio!=null)gameAudio.close();client.destroy();super.onDestroy();}
    private void requestPhoneInvite(){
        if(!isCar()||!connected||!foreground||!localAllowed||room==null)return;
        final String requested=room.optString("roomId");inviteButton.setEnabled(false);
        client.postApi("/api/rooms/"+requested+"/party/invite",new JSONObject(),new RoomClient.ApiCallback(){
            public void onResponse(JSONObject value){main.post(()->{if(room==null||!requested.equals(room.optString("roomId")))return;try{
                long ttl=value.getLong("expiresAt")-System.currentTimeMillis();if(ttl<=0)throw new IllegalStateException("초대 시간이 만료됨");
                BitMatrix bits=new MultiFormatWriter().encode(value.getString("joinUrl"),BarcodeFormat.QR_CODE,512,512);
                Bitmap bitmap=Bitmap.createBitmap(512,512,Bitmap.Config.ARGB_8888);int[] pixels=new int[512*512];
                for(int y=0;y<512;y++)for(int x=0;x<512;x++)pixels[y*512+x]=bits.get(x,y)?Color.BLACK:Color.WHITE;
                bitmap.setPixels(pixels,0,512,0,0,512,512);inviteRoomId=requested;inviteQr.setImageBitmap(bitmap);inviteQr.setVisibility(View.VISIBLE);inviteInfo.setText("폰으로 QR 스캔 → Google/게스트 로그인 → 참가 요청 → 이 차량에서 승인 · 120초 유효");main.removeCallbacks(expireInvite);main.postDelayed(expireInvite,ttl);
            }catch(Exception e){inviteInfo.setText("QR 발급 실패 · 다시 발급해 주세요");}updateGameVisibility();});}
            public void onError(String error){main.post(()->{inviteInfo.setText("QR 발급 실패 · 서버 연결을 확인해 주세요");updateGameVisibility();});}
        });
    }
    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);acceptTestIntent(intent);}
    final void receiveDebugCommand(Intent intent){main.post(()->acceptTestIntent(intent));}
    public void onStatus(String value){main.post(()->status.setText(value));event("connection",newJSONObject("message",value));}
    public void onDisconnected(){main.post(()->{connected=false;updateGameVisibility();});}
    public void onRoom(JSONObject value){main.post(()->{connected=true;room=value;updateGameVisibility();roomLabel.setText("ROOM "+value.optString("roomId")+"  CODE "+value.optString("joinCode","—")+"  "+value.optString("state"));
        JSONArray members=value.optJSONArray("members");StringBuilder label=new StringBuilder();approvals.removeAllViews();
        if(members!=null)for(int i=0;i<members.length();i++){JSONObject m=members.optJSONObject(i);if(m==null)continue;if(!isCar()&&m.optString("sessionId").equals(client.getSessionId()))localSeat=m.optString("seat",localSeat);label.append(m.optString("nickname")).append(" / ").append(m.optString("role")).append(" / ").append(m.optString("seatEvidence")).append(m.optBoolean("approved")?" ✓":" 승인 대기").append("\n");
            if(isCar()&&!m.optBoolean("approved")){final String id=m.optString("memberId"),seat=m.optString("seat");approvals.addView(button(m.optString("nickname")+" "+seat+" 승인",v->client.approve(id,seat)));}}
        JSONObject stats=value.optJSONObject("stats");if(stats!=null){JSONObject collection=value.optJSONObject("collection");JSONObject inventory=collection==null?null:collection.optJSONObject("inventory");statsLabel.setText("SHOTS "+stats.optInt("shots")+" · HITS "+stats.optInt("hits")+" · KILLS "+stats.optInt("kills")+" · SUPPLIES "+(inventory==null?0:inventory.optInt("supplies"))+(stats.optBoolean("supportActive")?" · SUPPORT ×"+stats.optInt("supportDamage",2):""));JSONObject shot=stats.optJSONObject("lastShot");if(shot!=null){long time=shot.optLong("time");if(sawRoom&&time>lastShotTime&&shot.optBoolean("accepted"))gameAudio.feedback(shot.optBoolean("hit"));lastShotTime=Math.max(lastShotTime,time);}}sawRoom=true;
        if(!isCar())refreshCollection(value);
        memberLabel.setText(label.toString());arena.setRoom(value);updateGameVisibility();onRoomData(value);});
        event("snapshot",summary(value));
        // Debug APK private state enables adb run-as verification without logging join secrets.
        try(FileWriter file=new FileWriter(new File(getFilesDir(),"room-state.json"),false)){file.write(value.toString(2));}catch(Exception ignored){}
    }
    private JSONObject summary(JSONObject value){JSONObject x=new JSONObject();try{x.put("roomId",value.optString("roomId")).put("state",value.optString("state")).put("roomEpoch",value.optLong("roomEpoch")).put("vehicle",value.optJSONObject("vehicle")).put("members",value.optJSONArray("members"));}catch(Exception ignored){}return x;}
    public void onResult(JSONObject value){main.post(()->resultLabel.setText(value.toString()));String action=pendingCommands.remove(value.optString("commandId"));if(action!=null){try{JSONObject receipt=new JSONObject(value.toString()).put("requestedAction",action);writePrivate("last-action-result.json",receipt);}catch(Exception ignored){}}event("server.result",value);}
    protected void applyVehicle(JSONObject value,boolean allowed){latestVehicle=value;localAllowed=allowed&&foreground;main.post(()->{diagnostics.setText(value.toString());updateGameVisibility();});if(foreground)sendVehicle();}
    protected void applyExtraDiagnostics(JSONObject value){writePrivate("cabin-state.json",value);main.post(()->{if(extraDiagnostics!=null)try{extraDiagnostics.setText(value.toString(2));}catch(Exception ignored){}});}
    private void updateGameVisibility(){if(inviteButton!=null){if(inviteRoomId!=null&&room!=null&&!inviteRoomId.equals(room.optString("roomId"))){main.removeCallbacks(expireInvite);inviteQr.setImageDrawable(null);inviteRoomId=null;}inviteButton.setEnabled(connected&&foreground&&localAllowed);inviteButton.setVisibility(foreground&&localAllowed?View.VISIBLE:View.GONE);inviteQr.setVisibility(foreground&&localAllowed&&inviteQr.getDrawable()!=null?View.VISIBLE:View.GONE);}if(gamePanel==null)return;boolean show=!isCar()||(localAllowed&&foreground);gamePanel.setVisibility(show?View.VISIBLE:View.GONE);if(isCar()){roomLabel.setVisibility(show?View.VISIBLE:View.GONE);memberLabel.setVisibility(show?View.VISIBLE:View.GONE);statsLabel.setVisibility(show?View.VISIBLE:View.GONE);approvals.setVisibility(show?View.VISIBLE:View.GONE);}else{int setup=connected?View.GONE:View.VISIBLE;serverInput.setVisibility(setup);nicknameInput.setVisibility(setup);accessKeyInput.setVisibility(setup);if(codeInput!=null)codeInput.setVisibility(setup);if(seats!=null)seats.setVisibility(setup);connectButton.setVisibility(setup);}String state=room==null?"WAITING":room.optString("state");boolean active=connected&&foreground&&"PLAYING".equals(state)&&(!isCar()||localAllowed);arena.update(localSeat,state,active);for(Button b:fireButtons)b.setEnabled(active);if(gameAudio!=null)gameAudio.setAllowed(active);if(!isCar()&&room!=null)refreshCollection(room);}
    protected void sendVehicle(){if(!isCar()||!connected||client==null)return;try{JSONObject message=new JSONObject(latestVehicle.toString());message.put("type","vehicle.report").put("commandId",UUID.randomUUID().toString()).put("reportSeq",reportCounter.incrementAndGet()).put("foreground",foreground);client.send(message);}catch(Exception e){event("report.error",newJSONObject("message",e.toString()));}}
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
