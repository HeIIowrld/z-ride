package ai.zride.car;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 합류·승인·보급품·공략 완료 때 짧은 알림음. 자체 생성 음이며 음원 파일이 없다.
 * 잠깐 다른 소리를 줄이는(duck) 포커스만 요청하고, 시스템 음량은 바꾸지 않는다.
 */
final class Chimes {
    private static final int RATE = 22050;
    private static final float LEVEL = 0.12f;
    private final AudioManager audio;
    private final ExecutorService player = Executors.newSingleThreadExecutor();
    private final AudioAttributes attributes = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
    private boolean enabled = true;

    Chimes(Context context) { audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE); }

    void setEnabled(boolean value) { enabled = value; }
    boolean enabled() { return enabled; }

    void join() { play(110, 660, 880); }
    void approved() { play(110, 784, 988); }
    void item() { play(110, 784, 988, 1319); }
    void clear() { play(130, 523, 659, 784, 1047, 784, 1047); }
    void support() { play(80, 392, 523, 659); }
    void tap() { play(90, 440); }

    private void play(int stepMs, int... freqs) {
        if (!enabled) return;
        player.execute(() -> {
            int step = RATE * stepMs / 1000, tail = RATE * 350 / 1000;
            int total = step * (freqs.length - 1) + tail;
            short[] pcm = new short[total];
            for (int n = 0; n < freqs.length; n++) {
                int start = n * step;
                for (int i = 0; i < tail && start + i < total; i++) {
                    double t = (double) i / RATE;
                    double env = Math.min(1, t / 0.02) * Math.exp(-t * 12);
                    // 삼각파: 부드럽고 작은 스피커에서도 잘 들림
                    double phase = (freqs[n] * t) % 1.0;
                    double wave = 4 * Math.abs(phase - 0.5) - 1;
                    pcm[start + i] = (short) Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, pcm[start + i] + wave * env * LEVEL * Short.MAX_VALUE));
                }
            }
            AudioFocusRequest focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attributes).build();
            if (audio.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return;
            AudioTrack track = null;
            try {
                track = new AudioTrack.Builder().setAudioAttributes(attributes)
                    .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setTransferMode(AudioTrack.MODE_STATIC).setBufferSizeInBytes(pcm.length * 2).build();
                track.write(pcm, 0, pcm.length);
                track.play();
                Thread.sleep(total * 1000L / RATE + 50);
            } catch (Exception ignored) {
            } finally {
                if (track != null) try { track.stop(); } catch (Exception ignored) {}
                if (track != null) track.release();
                audio.abandonAudioFocusRequest(focus);
            }
        });
    }

    void close() { player.shutdownNow(); }
}
