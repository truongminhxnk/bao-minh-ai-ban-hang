import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { decode, encode, decodeAudioData, playUISound } from './utils/audioHelpers';
import CameraView from './components/CameraView';
import { SessionStatus, Transcription } from './types';

interface DebugLog {
  id: string;
  timestamp: string;
  message: string;
  type: 'info' | 'api' | 'error' | 'success';
}

interface UIAudioSettings {
  enabled: boolean;
  profile: 'default' | 'crystal' | 'electronic';
  volume: number;
}

// Silent MP3 Data URI để giữ kết nối nền
const SILENT_AUDIO_URI = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD//////////////////////////////////////////////////////////////////wAAAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAASAA82xhAAAAAAA//OEZAAAAAAIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OEZAAAAAAIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OEZAAAAAAIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OEZAAAAAAIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

const App: React.FC = () => {
  const [productList, setProductList] = useState<string>(() => localStorage.getItem('gemini_product_list') || '');
  const [storeDocs, setStoreDocs] = useState<string>(() => localStorage.getItem('gemini_store_docs') || '');
  const [esp32Ip, setEsp32Ip] = useState<string>(() => localStorage.getItem('gemini_esp32_ip') || '');
  
  const [uiAudio, setUiAudio] = useState<UIAudioSettings>(() => {
    const saved = localStorage.getItem('gemini_ui_audio');
    return saved ? JSON.parse(saved) : { enabled: true, profile: 'default', volume: 0.5 };
  });

  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [isAISpeaking, setIsAISpeaking] = useState(false);
  const [activeProduct, setActiveProduct] = useState<string | null>(null);
  const [showProductModal, setShowProductModal] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'chat' | 'settings'>('chat');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false); 
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.IDLE);
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<DebugLog[]>([]);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [showCameraPreview, setShowCameraPreview] = useState(true);
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  
  const [isVoiceOnly, setIsVoiceOnly] = useState<boolean>(() => {
    return localStorage.getItem('gemini_voice_only') === 'true';
  });

  // State cho chế độ chạy nền
  const [isBackgroundMode, setIsBackgroundMode] = useState<boolean>(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const transcriptionBufferRef = useRef({ user: '', model: '' });
  const docInputRef = useRef<HTMLInputElement>(null);
  const productInputRef = useRef<HTMLInputElement>(null);
  const speakingTimeoutRef = useRef<number | null>(null);
  const activeSessionRef = useRef<any>(null);
  const silentAudioRef = useRef<HTMLAudioElement>(null);
  const wakeLockRef = useRef<any>(null);

  const volumeThreshold = 0.003;

  const productInfo = useMemo(() => {
    if (!activeProduct) return null;
    const urlRegex = /(https?:\/\/[^\s]+(?:\.jpg|\.jpeg|\.png|\.webp|\.gif))/i;
    const match = activeProduct.match(urlRegex);
    const imageUrl = match ? match[0] : null;
    const cleanText = activeProduct.replace(urlRegex, '').trim();
    const parts = cleanText.split(/[:,-]/);
    const name = parts[0]?.trim() || "Sản phẩm";
    const description = parts.slice(1).join(':').trim() || cleanText;
    return { name, description, imageUrl };
  }, [activeProduct]);

  const placeholderImage = "https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&q=80&w=400&h=400";

  useEffect(() => {
    localStorage.setItem('gemini_product_list', productList);
    localStorage.setItem('gemini_store_docs', storeDocs);
    localStorage.setItem('gemini_ui_audio', JSON.stringify(uiAudio));
    localStorage.setItem('gemini_esp32_ip', esp32Ip);
    localStorage.setItem('gemini_voice_only', String(isVoiceOnly));
  }, [productList, storeDocs, uiAudio, esp32Ip, isVoiceOnly]);

  // Handle visibility change for Wake Lock
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (isBackgroundMode && document.visibilityState === 'visible' && !wakeLockRef.current) {
        try {
          if ('wakeLock' in navigator) {
            wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
          }
        } catch (e) { console.error('Wake Lock Error', e); }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isBackgroundMode]);

  const triggerUISound = useCallback((type: 'click' | 'success') => {
    if (uiAudio.enabled) {
      playUISound(type, uiAudio.profile, uiAudio.volume);
    }
  }, [uiAudio]);

  const addLog = useCallback((message: string, type: 'info' | 'api' | 'error' | 'success' = 'info') => {
    const newLog: DebugLog = { id: Math.random().toString(36).substr(2, 9), timestamp: new Date().toLocaleTimeString(), message, type };
    setLogs(prev => [newLog, ...prev].slice(0, 30));
  }, []);

  const toggleBackgroundMode = async () => {
    const nextState = !isBackgroundMode;
    setIsBackgroundMode(nextState);
    triggerUISound('click');

    if (nextState) {
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        }
        if (silentAudioRef.current) {
          silentAudioRef.current.play().catch(e => console.error("Silent audio play failed", e));
        }
        addLog('Đã bật chế độ Chạy Nền', 'info');
      } catch (err: any) {
        addLog(`Lỗi bật chạy nền: ${err.message}`, 'error');
      }
    } else {
      if (wakeLockRef.current) {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
      if (silentAudioRef.current) {
        silentAudioRef.current.pause();
      }
      addLog('Đã tắt chế độ Chạy Nền', 'info');
    }
  };

  const addTranscription = useCallback((text: string, isUser: boolean) => {
    setTranscriptions(prev => [...prev.slice(-15), { text, isUser, timestamp: Date.now() }]);
  }, []);

  const detectProduct = useCallback((text: string) => {
    if (!productList) return;
    const lines = productList.split('\n').filter(l => l.trim().length > 3);
    for (const line of lines) {
      const parts = line.split(/[:,-]/);
      const productName = parts[0]?.trim();
      if (productName && text.toLowerCase().includes(productName.toLowerCase())) {
        setActiveProduct(line.trim());
        return;
      }
    }
  }, [productList]);

  const disconnectFromAI = useCallback(() => {
    triggerUISound('click');
    if (activeSessionRef.current) {
      activeSessionRef.current.close();
      activeSessionRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    sessionPromiseRef.current = null;
    setStatus(SessionStatus.IDLE);
    setIsUserSpeaking(false);
    setIsAISpeaking(false);
    addLog('Hệ thống đã dừng giám sát', 'info');
  }, [triggerUISound, addLog]);

  const handleCameraError = useCallback((error: string) => {
    if (!isVoiceOnly) {
      setPermissionError(error);
      addLog(error, 'error');
      if (status === SessionStatus.CONNECTED || status === SessionStatus.CONNECTING) {
         disconnectFromAI();
      }
    }
  }, [addLog, status, disconnectFromAI, isVoiceOnly]);

  const toggleVoiceOnly = () => {
    if (status === SessionStatus.CONNECTED || status === SessionStatus.CONNECTING) {
      disconnectFromAI();
    }
    setIsVoiceOnly(!isVoiceOnly);
    triggerUISound('click');
  };

  const requestPermissions = useCallback(async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true, video: !isVoiceOnly });
      setPermissionError(null);
      triggerUISound('success');
      addLog('Đã cấp quyền thiết bị thành công.', 'info');
    } catch (e: any) {
      setPermissionError("Vui lòng vào Cài đặt Android -> Ứng dụng -> Bảo Minh Smart AI -> Quyền -> Bật Micro & Camera.");
      addLog("Người dùng từ chối cấp quyền.", 'error');
    }
  }, [isVoiceOnly, triggerUISound, addLog]);

  const connectToAI = async () => {
    if (status === SessionStatus.CONNECTED) {
      disconnectFromAI();
      return;
    }

    triggerUISound('click');
    setPermissionError(null);
    if (status === SessionStatus.CONNECTING) return;
    
    // API Key được lấy trực tiếp từ biến môi trường theo yêu cầu bảo mật
    const apiKey = process.env.API_KEY;

    if (!apiKey) {
      const msg = 'Lỗi cấu hình: Thiếu API_KEY trong biến môi trường.';
      addLog(msg, 'error');
      setPermissionError(msg);
      setStatus(SessionStatus.ERROR);
      return;
    }

    setStatus(SessionStatus.CONNECTING);
    addLog('Đang khởi tạo AI...', 'info');
    
    const ai = new GoogleGenAI({ apiKey: apiKey });
    audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

    const systemInstruction = `
      VAI TRÒ: Bạn là Lễ tân AI thông minh tại cửa hàng Bảo Minh. Bạn đang nhìn qua Camera ${isVoiceOnly ? '(Hiện đang tắt)' : 'ESP32 gắn tại cửa ra vào'} và nghe qua Micro.

      NHIỆM VỤ CHÍNH (QUAN TRỌNG NHẤT):
      1. QUAN SÁT VÀ CHÀO KHÁCH: 
         - Nếu nhìn thấy có người xuất hiện trong khung hình: Hãy CHÀO NGAY LẬP TỨC bằng giọng vui tươi, to rõ.
         - Mẫu câu chào: "Dạ Bảo Minh xin chào! Mời anh/chị vào tham quan ạ.", "Xin chào quý khách!", "Chào bạn, mình có thể giúp gì cho bạn không?".
         - Lưu ý: Đừng chào lặp lại liên tục với cùng một người nếu họ chưa rời đi.
      
      2. TRÒ CHUYỆN VÀ TƯ VẤN:
         - Sẵn sàng trả lời các câu hỏi về sản phẩm, giá cả, dịch vụ.
         - Dựa vào danh sách sản phẩm: ${productList || '(Hỏi nhân viên)'}
         - Dựa vào tài liệu cửa hàng: ${storeDocs || ''}
      
      3. PHONG THÁI:
         - Nhanh nhẹn, thân thiện, hiếu khách.
         - Nếu không có ai trong khung hình, hãy giữ im lặng tuyệt đối để tiết kiệm năng lượng.
         - Nhận biết bạn đang sử dụng ESP32 Camera, đôi khi hình ảnh có thể trễ một chút, hãy kiên nhẫn.
    `;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(e => {
        throw new Error("Lỗi Microphone: Vui lòng cấp quyền truy cập âm thanh.");
      });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(SessionStatus.CONNECTED);
            triggerUISound('success');
            addLog(isVoiceOnly ? 'Kết nối Audio OK.' : 'Kết nối ESP32/Cam & Audio OK.', 'api');
            
            sessionPromise.then(session => {
              session.sendRealtimeInput({ text: isVoiceOnly ? "Hệ thống đã bật." : "Hệ thống Vision ESP32 đã bật. Hãy quan sát camera và chào khách ngay khi thấy họ." });
            });

            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(2048, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              const rms = Math.sqrt(sum / inputData.length);
              const isSilent = rms < volumeThreshold;

              if (!isSilent && !isMuted) {
                setIsUserSpeaking(true);
                if (speakingTimeoutRef.current) window.clearTimeout(speakingTimeoutRef.current);
                speakingTimeoutRef.current = window.setTimeout(() => setIsUserSpeaking(false), 300);
              }

              if (activeSessionRef.current) {
                const int16 = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                  int16[i] = (isMuted || isSilent) ? 0 : inputData[i] * 32768;
                }
                const pcmBlob = { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
                activeSessionRef.current.sendRealtimeInput({ media: pcmBlob });
              }
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              setIsAISpeaking(true);
              const ctx = outputAudioContextRef.current!;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
              source.onended = () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setIsAISpeaking(false);
              };
            }
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsAISpeaking(false);
            }
            if (message.serverContent?.turnComplete) {
              const uText = transcriptionBufferRef.current.user;
              const mText = transcriptionBufferRef.current.model;
              if (uText) addTranscription(uText, true);
              if (mText) {
                addTranscription(mText, false);
                detectProduct(mText);
              }
              transcriptionBufferRef.current = { user: '', model: '' };
            }
            if (message.serverContent?.inputTranscription) {
              transcriptionBufferRef.current.user += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              transcriptionBufferRef.current.model += text;
              detectProduct(transcriptionBufferRef.current.model);
            }
          },
          onerror: (e: any) => {
            addLog(`Sự cố: ${e?.message || 'Lỗi phiên làm việc'}`, 'error');
            disconnectFromAI();
          },
          onclose: () => {
            setStatus(SessionStatus.IDLE);
            setIsUserSpeaking(false);
            setIsAISpeaking(false);
            activeSessionRef.current = null;
          }
        }
      });
      sessionPromiseRef.current = sessionPromise;
      activeSessionRef.current = await sessionPromise;
    } catch (err: any) {
      addLog(err.message, 'error');
      setPermissionError(err.message);
      setStatus(SessionStatus.ERROR);
    }
  };

  const handleFrame = (base64: string) => {
    if (!isVoiceOnly && status === SessionStatus.CONNECTED && activeSessionRef.current) {
      activeSessionRef.current.sendRealtimeInput({ media: { data: base64, mimeType: 'image/jpeg' } });
    }
  };

  const toggleSidebar = () => {
    triggerUISound('click');
    setIsSidebarOpen(!isSidebarOpen);
  };

  const toggleCameraPreview = () => {
    triggerUISound('click');
    setShowCameraPreview(!showCameraPreview);
  };

  const handleDocUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        setStoreDocs(text);
        triggerUISound('success');
        addLog('Đã cập nhật tài liệu cửa hàng mới', 'info');
      };
      reader.readAsText(file);
    }
  };

  const handleProductUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const isImage = file.type.startsWith('image/');
    const isPdf = file.type === 'application/pdf';
    const isText = file.type === 'text/plain' || file.type === 'text/csv' || file.type === 'application/json' || file.name.endsWith('.md');

    if (isText) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        setProductList(prev => prev ? prev + '\n' + text : text);
        triggerUISound('success');
        addLog('Đã cập nhật danh mục sản phẩm từ file text', 'info');
      };
      reader.readAsText(file);
    } else if (isImage || isPdf) {
       setIsProcessingFile(true);
       addLog(`Đang dùng AI đọc dữ liệu từ ${file.name}...`, 'info');
       try {
         const base64 = await new Promise<string>((resolve) => {
             const r = new FileReader();
             r.onload = () => resolve((r.result as string).split(',')[1]);
             r.readAsDataURL(file);
         });
         
         const apiKey = process.env.API_KEY;
         if(!apiKey) throw new Error("Chưa có API KEY");
         
         const ai = new GoogleGenAI({ apiKey });
         const response = await ai.models.generateContent({
             model: 'gemini-2.0-flash-exp',
             contents: {
                 parts: [
                     { inlineData: { mimeType: file.type, data: base64 } },
                     { text: "Bạn là trợ lý nhập liệu. Hãy trích xuất danh sách sản phẩm từ hình ảnh/tài liệu này. Trả về kết quả dưới dạng danh sách text đơn giản, mỗi dòng một sản phẩm theo định dạng: 'Tên sản phẩm: Giá (nếu có) - Mô tả (nếu có)'. Bỏ qua các chi tiết thừa." }
                 ]
             }
         });
         
         const text = response.text;
         if(text) {
             setProductList(prev => prev ? prev + '\n' + text : text);
             triggerUISound('success');
             addLog(`Đã trích xuất xong dữ liệu từ file.`, 'success');
         }
       } catch(err: any) {
           addLog(`Lỗi đọc file AI: ${err.message}. Vui lòng thử file Text/CSV.`, 'error');
       } finally {
           setIsProcessingFile(false);
       }
    } else {
        addLog('Định dạng này cần được chuyển sang PDF hoặc Chụp ảnh để AI xử lý.', 'error');
    }
  };

  const isObserverMode = status === SessionStatus.CONNECTED && !isAISpeaking && !isUserSpeaking;

  return (
    <div className="h-screen w-full flex flex-col md:flex-row bg-[#020617] text-slate-200 overflow-hidden relative font-sans">
      
      <audio ref={silentAudioRef} loop src={SILENT_AUDIO_URI} className="hidden" playsInline />

      {!isVoiceOnly && (
        <CameraView 
          isActive={status === SessionStatus.CONNECTED} 
          showPreview={showCameraPreview}
          esp32Ip={esp32Ip}
          onFrame={handleFrame} 
          onError={handleCameraError} 
        />
      )}

      {permissionError && (
        <div className="fixed inset-0 z-[200] bg-black/80 backdrop-blur-md flex items-center justify-center p-6 text-center animate-[fadeIn_0.3s_ease-out]">
          <div className="max-w-md space-y-6">
            <div className="w-16 h-16 sm:w-20 sm:h-20 bg-red-500/20 rounded-full flex items-center justify-center mx-auto border border-red-500/50">
               <svg className="w-8 h-8 sm:w-10 sm:h-10 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
            </div>
            <h2 className="text-xl sm:text-2xl font-black text-white uppercase tracking-tighter">Thông báo hệ thống</h2>
            <p className="text-slate-400 text-xs sm:text-sm leading-relaxed">{permissionError}</p>
            <div className="flex flex-col gap-3">
               <button onClick={requestPermissions} className="px-8 py-3 bg-indigo-600 rounded-xl font-bold text-white hover:bg-indigo-500 transition-all active:scale-95 border border-indigo-400 shadow-lg shadow-indigo-500/30">CẤP QUYỀN TRUY CẬP</button>
               <button onClick={() => setPermissionError(null)} className="px-8 py-2 bg-slate-700 rounded-xl font-bold text-white hover:bg-slate-600 transition-all active:scale-95 text-xs">ĐÓNG</button>
            </div>
          </div>
        </div>
      )}

      {showProductModal && productInfo && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 sm:p-6 bg-slate-950/90 backdrop-blur-xl animate-[fadeIn_0.2s_ease-out]">
          <div className="bg-[#0f172a] w-full max-w-lg border border-white/10 rounded-[2rem] overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
            <div className="h-40 sm:h-56 overflow-hidden relative group flex-shrink-0">
              <img src={productInfo.imageUrl || placeholderImage} className="w-full h-full object-cover" alt={productInfo.name} />
              <div className="absolute inset-0 bg-gradient-to-t from-[#0f172a] via-transparent to-transparent"></div>
            </div>
            <div className="p-5 sm:p-10 space-y-4 overflow-y-auto scrollbar-hide">
              <h3 className="text-xl sm:text-3xl font-extrabold text-white tracking-tight">{productInfo.name}</h3>
              <div className="bg-black/40 p-4 sm:p-5 rounded-2xl border border-white/5 leading-relaxed text-slate-300 font-medium text-xs sm:text-sm whitespace-pre-wrap">
                {productInfo.description}
              </div>
              <button onClick={() => setShowProductModal(false)} className="w-full py-3 sm:py-4 bg-indigo-600 text-white font-black rounded-xl active:scale-95 uppercase tracking-widest text-[10px] sm:text-xs">ĐÓNG</button>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col p-4 sm:p-8 md:p-12 space-y-4 sm:space-y-6 relative overflow-hidden h-full">
        <div className="flex justify-between items-center z-10 h-14 sm:h-auto">
          <div className="flex items-center space-x-3">
            <div className={`w-8 h-8 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center font-black transition-all ${status === SessionStatus.CONNECTED ? 'bg-indigo-600 scale-105 shadow-lg shadow-indigo-600/30' : 'bg-slate-800'}`}>
              <span className="text-xs sm:text-base">BM</span>
            </div>
            <div>
              <h1 className="font-black text-white uppercase tracking-tighter text-xs sm:text-lg leading-tight">BẢO MINH SMART STORE</h1>
              <div className="flex items-center gap-1.5 sm:gap-2">
                <span className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full ${status === SessionStatus.CONNECTED ? 'bg-green-500 animate-pulse shadow-[0_0_8px_#22c55e]' : 'bg-slate-700'}`}></span>
                <p className="text-[7px] sm:text-[10px] text-slate-500 font-bold uppercase tracking-widest truncate max-w-[100px] sm:max-w-none">
                  {status === SessionStatus.CONNECTED ? (isObserverMode ? (isVoiceOnly ? 'ĐANG LẮNG NGHE' : 'ESP32 ĐANG QUAN SÁT') : 'GIAO TIẾP') : status}
                </p>
              </div>
            </div>
          </div>
          <div className="flex gap-1.5 sm:gap-2">
            <button
               onClick={toggleVoiceOnly}
               className={`flex items-center gap-1.5 px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-xl border transition-all ${isVoiceOnly ? 'bg-orange-500/20 border-orange-500 text-orange-400' : 'bg-slate-800 border-slate-700 text-slate-400'}`}
               title="Chế độ Chỉ Âm Thanh (Không Camera)"
            >
               <svg className="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
               <span className="text-[8px] sm:text-[10px] font-bold uppercase tracking-wide hidden sm:inline">NO CAM</span>
            </button>

            {!isVoiceOnly && (
              <button 
                onClick={toggleCameraPreview} 
                className={`p-2 sm:p-2.5 rounded-xl border transition-all ${!showCameraPreview ? 'bg-slate-800 border-slate-700 text-slate-400' : 'bg-indigo-600/20 border-indigo-500 text-indigo-400'}`}
              >
                 <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                 </svg>
              </button>
            )}
            <button onClick={toggleSidebar} className="md:hidden p-2 sm:p-2.5 bg-slate-800 rounded-xl border border-slate-700 text-slate-400 active:scale-95">
               <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16m-7 6h7" /></svg>
            </button>
          </div>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center relative py-4 sm:py-10">
          <div className={`absolute inset-0 scale-[1.8] sm:scale-[2.8] rounded-full blur-[80px] sm:blur-[120px] transition-all duration-1000 ${
            isAISpeaking ? 'bg-indigo-500/30' : 
            isUserSpeaking ? 'bg-emerald-500/30' : 
            status === SessionStatus.CONNECTED ? (isObserverMode ? 'bg-blue-500/10' : 'bg-indigo-500/20') : 'bg-slate-500/5'
          }`}></div>
          
          <div className={`w-40 h-40 sm:w-72 sm:h-72 rounded-full flex items-center justify-center relative transition-all duration-700 ${
            isAISpeaking || isUserSpeaking ? 'scale-105 sm:scale-110' : isObserverMode ? 'scale-90 sm:scale-95 opacity-80' : 'scale-100'
          }`}>
            <div className={`absolute inset-0 border border-indigo-500/10 rounded-full ${status === SessionStatus.CONNECTED && !isObserverMode ? 'animate-[spin_12s_linear_infinite] border-2' : ''}`}></div>
            <div className={`absolute inset-4 sm:inset-6 border border-white/5 rounded-full ${status === SessionStatus.CONNECTED ? 'animate-[spin_20s_linear_infinite_reverse]' : ''}`}></div>
            
            <div className={`w-28 h-28 sm:w-52 sm:h-52 rounded-full flex items-center justify-center shadow-2xl relative transition-all duration-500 ${
              isAISpeaking ? 'bg-indigo-600 shadow-indigo-600/40' : 
              isUserSpeaking ? 'bg-emerald-600 shadow-emerald-600/40' : 
              isObserverMode ? 'bg-slate-800 border border-indigo-500/20' : 'bg-indigo-700'
            }`}>
              <div className="relative z-10 flex flex-col items-center">
                 {isVoiceOnly && status === SessionStatus.CONNECTED && (
                   <div className="mb-1 text-indigo-200">
                     <svg className="w-6 h-6 sm:w-8 sm:h-8 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                   </div>
                 )}
                 <span className="text-white font-black text-xl sm:text-4xl tracking-[0.2em] mb-0.5 drop-shadow-lg">
                    {isAISpeaking ? 'AI' : isUserSpeaking ? '...' : 'BM'}
                 </span>
                 {isObserverMode && <span className="text-[6px] sm:text-[8px] font-black text-indigo-400/60 uppercase tracking-widest">{isVoiceOnly ? 'LISTEN' : 'WATCH'}</span>}
              </div>
            </div>
          </div>

          <div className="mt-8 sm:mt-16 text-center space-y-2 sm:space-y-3 z-10 px-4">
            <h3 className="text-sm sm:text-xl font-black text-white uppercase tracking-[0.2em] sm:tracking-[0.4em]">
              {status === SessionStatus.CONNECTED ? (isObserverMode ? (isVoiceOnly ? 'ĐANG LẮNG NGHE' : 'ESP32 ĐANG QUAN SÁT') : 'HỖ TRỢ KHÁCH') : 'HỆ THỐNG SẴN SÀNG'}
            </h3>
            <p className="text-[8px] sm:text-[10px] text-slate-500 font-bold uppercase tracking-widest max-w-[240px] sm:max-w-sm leading-relaxed mx-auto">
              {status === SessionStatus.CONNECTED 
                ? (isVoiceOnly ? 'Hệ thống đang chờ lệnh nói từ Microphone.' : 'AI đang quan sát qua ESP32 và sẽ chào khách khi thấy.') 
                : 'Kết nối IP Camera và Bắt đầu.'}
            </p>
          </div>
        </div>

        <div className="z-10 pb-2 sm:pb-4 flex flex-col gap-3">
          <button
            onClick={connectToAI}
            disabled={status === SessionStatus.CONNECTING}
            className={`w-full py-5 sm:py-8 rounded-3xl sm:rounded-[2.5rem] text-lg sm:text-2xl font-black transition-all active:scale-95 shadow-xl ${
              status === SessionStatus.CONNECTED 
                ? 'bg-slate-800 text-red-500 border border-red-500/20' 
                : 'bg-indigo-600 text-white shadow-indigo-600/20'
            }`}
          >
            {status === SessionStatus.CONNECTING ? 'ĐANG KHỞI TẠO...' : status === SessionStatus.CONNECTED ? 'DỪNG GIÁM SÁT' : 'BẮT ĐẦU GIÁM SÁT'}
          </button>
          
          <button 
            onClick={() => setShowLogs(!showLogs)}
            className="md:hidden py-2 text-[8px] font-black text-slate-600 uppercase tracking-widest text-center"
          >
            {showLogs ? 'Ẩn Logs hệ thống' : 'Hiện Logs hệ thống'}
          </button>
        </div>

        {showLogs && (
          <div className="absolute bottom-32 sm:bottom-24 left-4 right-4 sm:left-12 sm:right-12 h-40 sm:h-48 bg-black/90 backdrop-blur-2xl border border-white/10 rounded-2xl overflow-hidden flex flex-col z-[150] animate-[fadeIn_0.2s_ease-out]">
            <div className="flex justify-between items-center p-3 border-b border-white/5 bg-white/5">
              <span className="text-[8px] sm:text-[10px] font-black text-indigo-400 uppercase tracking-widest">TELEMETRY</span>
              <button onClick={() => setShowLogs(false)} className="text-slate-500 p-1">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5 font-mono text-[9px] sm:text-xs text-slate-400 scrollbar-hide">
              {logs.map((log) => (
                <div key={log.id} className="flex gap-2">
                  <span className="text-slate-600 shrink-0">[{log.timestamp}]</span>
                  <span className={
                    log.type === 'error' ? 'text-red-400' : 
                    log.type === 'success' ? 'text-emerald-400' : 
                    'text-slate-300'
                  }>{log.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className={`
        fixed inset-y-0 right-0 w-full sm:w-[420px] md:w-[480px] bg-[#0f172a] border-l border-white/5 flex flex-col shadow-2xl z-[160] transition-transform duration-500 ease-out
        ${isSidebarOpen ? 'translate-x-0' : 'translate-x-full'} md:translate-x-0 md:relative md:z-20
      `}>
        <div className="flex border-b border-white/5 bg-black/40 flex-shrink-0">
          <button onClick={() => setSidebarTab('chat')} className={`flex-1 py-6 sm:py-7 text-[9px] sm:text-[10px] font-black uppercase tracking-[0.2em] transition-all ${sidebarTab === 'chat' ? 'text-indigo-400 bg-white/[0.02] border-b-2 border-indigo-500' : 'text-slate-600'}`}>LỊCH SỬ</button>
          <button onClick={() => setSidebarTab('settings')} className={`flex-1 py-6 sm:py-7 text-[9px] sm:text-[10px] font-black uppercase tracking-[0.2em] transition-all ${sidebarTab === 'settings' ? 'text-indigo-400 bg-white/[0.02] border-b-2 border-indigo-500' : 'text-slate-600'}`}>CÀI ĐẶT</button>
          <button onClick={toggleSidebar} className="md:hidden px-6 text-slate-500">
             <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 sm:p-10 flex flex-col gap-6 sm:gap-8 scrollbar-hide pb-20 sm:pb-24">
          {sidebarTab === 'chat' ? (
            <div className="space-y-5">
              {productInfo && (
                <div className="bg-indigo-600/10 border border-indigo-500/20 rounded-2xl p-4 sm:p-6 space-y-3 animate-[slideDown_0.3s_ease-out]">
                  <div className="text-[8px] font-black text-indigo-400 uppercase tracking-widest">Đang xem sản phẩm</div>
                  <div className="flex gap-3 items-center">
                    <div className="w-14 h-14 sm:w-20 sm:h-20 rounded-xl overflow-hidden border border-white/10 shadow-lg">
                       <img src={productInfo.imageUrl || placeholderImage} className="w-full h-full object-cover" alt="" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-extrabold text-white text-sm sm:text-base leading-tight truncate">{productInfo.name}</h4>
                      <button onClick={() => setShowProductModal(true)} className="text-[8px] sm:text-[10px] text-indigo-400 font-bold uppercase tracking-widest mt-1 border-b border-indigo-500/30">Xem chi tiết</button>
                    </div>
                  </div>
                </div>
              )}
              
              <div className="space-y-5 pt-2">
                {transcriptions.length === 0 && (
                  <div className="py-20 text-center opacity-30">
                    <p className="text-[8px] sm:text-[10px] font-black uppercase tracking-[0.2em]">Chưa có dữ liệu trò chuyện...</p>
                  </div>
                )}
                {transcriptions.map((t, i) => (
                  <div key={t.timestamp + i} className={`flex flex-col ${t.isUser ? 'items-end' : 'items-start'} animate-[fadeIn_0.3s_ease-out]`}>
                    <div className={`max-w-[90%] p-4 rounded-2xl text-xs sm:text-sm leading-relaxed ${t.isUser ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-slate-800 text-slate-200 rounded-tl-none border border-white/5'}`}>
                      {t.text}
                    </div>
                    <div className="mt-1.5 px-1 text-[7px] font-bold text-slate-600 uppercase tracking-tighter">
                       {t.isUser ? 'KHÁCH' : 'TRỢ LÝ'} • {new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-8 pb-10">
              <div className="space-y-4">
                 <label className="text-[8px] sm:text-[10px] font-black text-orange-500 uppercase tracking-widest">THIẾT BỊ ĐẦU VÀO & CẤU HÌNH</label>
                 <button onClick={toggleVoiceOnly} className={`w-full py-3 rounded-xl border font-black text-[9px] sm:text-xs tracking-widest transition-all mb-2 ${isVoiceOnly ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>
                    {isVoiceOnly ? 'CHẾ ĐỘ: CHỈ ÂM THANH' : 'CHẾ ĐỘ: ESP32 VISION + VOICE'}
                 </button>
                 
                 <button onClick={toggleBackgroundMode} className={`w-full py-3 rounded-xl border font-black text-[9px] sm:text-xs tracking-widest transition-all flex items-center justify-center gap-2 ${isBackgroundMode ? 'bg-emerald-600 border-emerald-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400'}`}>
                    {isBackgroundMode ? 'ĐANG CHẠY NỀN & KHÓA MÀN HÌNH' : 'BẬT CHẠY KHI KHÓA MÀN HÌNH'}
                 </button>

                 {!isVoiceOnly && (
                   <div className="bg-orange-500/5 border border-orange-500/10 rounded-xl p-4 space-y-2 animate-[fadeIn_0.2s_ease-out] mt-3">
                     <p className="text-[8px] text-orange-400 uppercase font-black tracking-widest">IP ESP32 CAM / STREAM URL</p>
                     <p className="text-[8px] text-slate-500 mb-2">Nhập IP (VD: 192.168.1.9) hoặc URL stream MJPEG</p>
                     <input 
                       type="text" 
                       value={esp32Ip} 
                       onChange={(e) => setEsp32Ip(e.target.value)} 
                       placeholder="Nhập IP ESP32..." 
                       className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-3 text-sm text-orange-200 focus:outline-none focus:border-orange-500/50 font-mono" 
                     />
                   </div>
                 )}
              </div>

              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <label className="text-[8px] sm:text-[10px] font-black text-slate-500 uppercase tracking-widest">TÀI LIỆU CỬA HÀNG</label>
                  <button onClick={() => docInputRef.current?.click()} className="text-[9px] sm:text-xs px-3 py-1.5 bg-indigo-600/10 hover:bg-indigo-600/20 text-indigo-400 font-black rounded-lg transition-colors border border-indigo-500/20">TẢI LÊN (.txt)</button>
                </div>
                <input type="file" ref={docInputRef} onChange={handleDocUpload} className="hidden" accept=".txt,.md" />
                <textarea 
                  value={storeDocs} 
                  onChange={(e) => setStoreDocs(e.target.value)}
                  className="w-full h-32 bg-black/40 border border-white/10 rounded-xl p-4 text-[10px] focus:border-indigo-500/30 resize-none text-slate-400"
                  placeholder="Dán nội dung STORE_DOCS.MD vào đây..."
                />
              </div>

              <div className="space-y-4">
                <div className="flex justify-between items-center">
                   <label className="text-[8px] sm:text-[10px] font-black text-slate-500 uppercase tracking-widest">DANH MỤC SẢN PHẨM</label>
                   <button 
                     onClick={() => productInputRef.current?.click()} 
                     disabled={isProcessingFile}
                     className={`text-[9px] sm:text-xs px-3 py-1.5 font-black rounded-lg transition-colors border border-indigo-500/20 flex items-center gap-2 ${isProcessingFile ? 'bg-slate-700 text-slate-400 cursor-wait' : 'bg-indigo-600/10 hover:bg-indigo-600/20 text-indigo-400'}`}
                   >
                     {isProcessingFile ? 'ĐANG ĐỌC AI...' : 'TẢI LÊN / ẢNH (OCR)'}
                   </button>
                </div>
                <input type="file" ref={productInputRef} onChange={handleProductUpload} className="hidden" accept=".txt,.csv,.json,.md,.jpg,.jpeg,.png,.webp,.pdf,.doc,.docx,.xls,.xlsx" />
                <textarea 
                  value={productList} 
                  onChange={(e) => setProductList(e.target.value)}
                  className="w-full h-32 bg-black/40 border border-white/10 rounded-xl p-4 text-[10px] focus:border-indigo-500/30 resize-none text-slate-400"
                  placeholder="Tên SP: Giá: Link ảnh..."
                />
              </div>
            </div>
          )}
        </div>
        <div className="p-8 bg-black/60 text-[8px] text-slate-700 text-center font-black uppercase tracking-[0.5em] border-t border-white/5">BẢO MINH INTELLIGENCE v5.2 | ESP32 READY</div>
      </div>
      
      {isSidebarOpen && <div className="fixed inset-0 bg-black/70 z-[155] md:hidden backdrop-blur-sm transition-all" onClick={toggleSidebar} />}
    </div>
  );
};

export default App;