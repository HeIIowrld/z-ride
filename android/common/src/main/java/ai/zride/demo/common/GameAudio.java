package ai.zride.demo.common;

import android.content.Context;
import android.media.*;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.util.function.Consumer;

/** Short opt-in game sounds on the default route; never controls vehicle speakers. */
final class GameAudio {
    private final AudioManager manager;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final AudioAttributes attributes=new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
    private final AudioFocusRequest focus;
    private final Consumer<String> log;
    private AudioTrack track;
    private boolean enabled,allowed,hasFocus;
    private float gain=.06f;
    private long lastPlay;
    private final Runnable timedStop=this::stop;
    GameAudio(Context context,Consumer<String> log){
        manager=(AudioManager)context.getSystemService(Context.AUDIO_SERVICE);this.log=log;
        focus=new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(attributes).setAcceptsDelayedFocusGain(false).setWillPauseWhenDucked(true)
            .setOnAudioFocusChangeListener(change->{
                log.accept("focusChange="+change);
                if(change!=AudioManager.AUDIOFOCUS_GAIN)stop();
                // Focus returning does not restart a sound or a round.
            },main).build();
    }
    void setEnabled(boolean value){enabled=value;if(!value)stop();}
    void setAllowed(boolean value){allowed=value;if(!value)stop();}
    void setGain(float value){gain=Math.max(0,Math.min(.15f,value));}
    void feedback(boolean hit){
        if(!enabled||!allowed||SystemClock.elapsedRealtime()-lastPlay<120)return;
        lastPlay=SystemClock.elapsedRealtime();stop();
        try{
            int granted=manager.requestAudioFocus(focus);log.accept("request USAGE_GAME result="+granted);
            if(granted!=AudioManager.AUDIOFOCUS_REQUEST_GRANTED)return;
            hasFocus=true;
            int rate=22050,ms=hit?110:65,count=rate*ms/1000;short[] pcm=new short[count];
            for(int i=0;i<count;i++){double envelope=Math.sin(Math.PI*i/count);double frequency=hit?820-280d*i/count:460-120d*i/count;pcm[i]=(short)(Math.sin(2*Math.PI*frequency*i/rate)*envelope*gain*Short.MAX_VALUE);}
            track=new AudioTrack.Builder().setAudioAttributes(attributes)
                .setAudioFormat(new AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setBufferSizeInBytes(count*2).setTransferMode(AudioTrack.MODE_STATIC).build();
            int written=track.write(pcm,0,pcm.length);if(written!=pcm.length||track.getState()!=AudioTrack.STATE_INITIALIZED)throw new IllegalStateException("AudioTrack initialization/write failed: "+written);
            track.play();log.accept("play generated effect hit="+hit+" gain="+gain+" route=DEFAULT state="+track.getPlayState());
            final AudioTrack playing=track;main.postDelayed(()->{if(track==playing)try{AudioDeviceInfo route=playing.getRoutedDevice();log.accept("playbackFrames="+playing.getPlaybackHeadPosition()+" routedDeviceType="+(route==null?"UNKNOWN":route.getType()));}catch(Exception ignored){}},ms/2L);
            main.postDelayed(timedStop,ms+40L);
        }catch(Exception e){log.accept("audioError="+e.getClass().getSimpleName()+":"+e.getMessage());stop();}
    }
    void stop(){main.removeCallbacks(timedStop);if(track!=null){try{track.pause();track.flush();track.release();}catch(Exception ignored){}track=null;}if(hasFocus){hasFocus=false;manager.abandonAudioFocusRequest(focus);log.accept("focus abandoned");}}
    void close(){enabled=false;allowed=false;stop();}
}
