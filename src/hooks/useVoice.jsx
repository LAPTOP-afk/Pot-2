import { useCallback } from 'react';
let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let source = null;

export const useVoice = () => {
    const playOrStop = useCallback((data, onEnded) => {
        if (source) {
            // 如果正在播放，停止播放
            source.stop();
            source.disconnect();
            source = null;
        } else {
            // 如果没在播放，开始播放
            audioContext.decodeAudioData(
                new Uint8Array(data).buffer,
                (buffer) => {
                    source = audioContext.createBufferSource();
                    source.buffer = buffer;
                    source.connect(audioContext.destination);
                    source.start();
                    source.onended = () => {
                        source.disconnect();
                        source = null;
                        if (typeof onEnded === 'function') {
                            onEnded();
                        }
                    };
                },
                () => {
                    // 解码失败也回调，避免调用方窗口一直挂起
                    if (typeof onEnded === 'function') {
                        onEnded();
                    }
                }
            );
        }
    });

    return playOrStop;
};
