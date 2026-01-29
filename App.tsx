import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { decode, encode, decodeAudioData, playUISound, detectBluetoothDevices, getUserMediaWithBluetoothPreference, createAudioContextWithBluetoothOutput, BluetoothDeviceInfo } from './utils/audioHelpers';
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

type UserRole = 'ADMIN' | 'USER';
type PlanType = 'TRIAL' | 'MONTHLY' | 'YEARLY';

interface GreeterUser {
  id: string;
  loginId: string;
  password: string;
  name: string;
  role: UserRole;
  plan: PlanType;
  expiry: number; // timestamp (ms)
  phone?: string;
  note?: string;
}

const ADMIN_ID = 'truong2024.vn';
const ADMIN_PASS = '#Minh@123';

const PLAN_DURATIONS: Record<PlanType, number> = {
  TRIAL: 7,
  MONTHLY: 30,
  YEARLY: 365,
};

const SEPAY_ACCOUNT = 'VQRQAGPFR0030';
const SEPAY_BANK = 'MBBank';

// Thời gian dùng thử cho khách (phút)
const TRIAL_MINUTES = 15;

const ZALO_CONTACT_PHONE = '0986234983';
const ZALO_LINK = `https://zalo.me/${ZALO_CONTACT_PHONE.replace(/\./g, '')}`;
const ZALO_QR_URL = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(
  ZALO_LINK
)}`;

const AI_STUDIO_API_KEY_URL = 'https://aistudio.google.com/app/apikey';

const getSepayQRUrl = (amount: number, loginId: string): string => {
  const base = 'https://qr.sepay.vn/img';
  const params = new URLSearchParams({
    acc: SEPAY_ACCOUNT,
    bank: SEPAY_BANK,
    amount: String(amount),
    memo: `VT-${loginId}`,
  });
  return `${base}?${params.toString()}`;
};

// Silent MP3 Data URI để giữ kết nối nền
const SILENT_AUDIO_URI = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMD//////////////////////////////////////////////////////////////////wAAAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAASAA82xhAAAAAAA//OEZAAAAAAIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OEZAAAAAAIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OEZAAAAAAIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//OEZAAAAAAIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

type AudioRoute = 'auto' | 'prefer_bluetooth' | 'prefer_phone';

const App: React.FC = () => {
  const [productList, setProductList] = useState<string>(() => localStorage.getItem('gemini_product_list') || '');
  const [storeDocs, setStoreDocs] = useState<string>(() => localStorage.getItem('gemini_store_docs') || '');
  const [esp32Ip, setEsp32Ip] = useState<string>(() => localStorage.getItem('gemini_esp32_ip') || '');
  
  const [uiAudio, setUiAudio] = useState<UIAudioSettings>(() => {
    const saved = localStorage.getItem('gemini_ui_audio');
    return saved ? JSON.parse(saved) : { enabled: true, profile: 'default', volume: 0.5 };
  });

  // Phiên đăng nhập & danh sách người dùng (local-only, không có backend)
  const [currentUser, setCurrentUser] = useState<GreeterUser | null>(() => {
    try {
      const raw = localStorage.getItem('bm_greeter_session');
      return raw ? (JSON.parse(raw) as GreeterUser) : null;
    } catch {
      return null;
    }
  });

  const [users, setUsers] = useState<GreeterUser[]>(() => {
    try {
      const raw = localStorage.getItem('bm_greeter_users');
      return raw ? (JSON.parse(raw) as GreeterUser[]) : [];
    } catch {
      return [];
    }
  });

  // Modal đăng nhập (hiển thị sau 1 phút nếu chưa đăng nhập, hoặc ngay sau khi đăng xuất)
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authCreds, setAuthCreds] = useState({ loginId: '', password: '' });
  const [authError, setAuthError] = useState<string | null>(null);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [editingUser, setEditingUser] = useState<GreeterUser | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState<number>(0);
  const [isCheckingPayment, setIsCheckingPayment] = useState(false);
  const [hasUsedTrialOnDevice, setHasUsedTrialOnDevice] = useState<boolean>(() => {
    try {
      return localStorage.getItem('bm_greeter_trial_used') === 'true';
    } catch {
      return false;
    }
  });
  const [customApiKey, setCustomApiKey] = useState<string>(() => {
    try {
      return localStorage.getItem('bm_greeter_api_key') || '';
    } catch {
      return '';
    }
  });
  const [showTrialNotice, setShowTrialNotice] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem('bm_greeter_session');
      const session = raw ? (JSON.parse(raw) as GreeterUser) : null;
      return !session;
    } catch {
      return true;
    }
  });

  // IP cảm biến chuyển động (ESP32 PIR). Nếu để trống sẽ dùng chung IP ESP32 Cam.
  const [motionSensorIp, setMotionSensorIp] = useState<string>(() => {
    try {
      return localStorage.getItem('bm_motion_sensor_ip') || '';
    } catch {
      return '';
    }
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
  
  // State cho thiết bị Bluetooth
  const [bluetoothInfo, setBluetoothInfo] = useState<BluetoothDeviceInfo | null>(null);
  const [showBluetoothNotification, setShowBluetoothNotification] = useState(false);

  // Người dùng chọn route audio (ưu tiên Bluetooth hay điện thoại)
  const [audioRoute, setAudioRoute] = useState<AudioRoute>('auto');

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
  // Thời điểm kết thúc giai đoạn khách (TRIAL_MINUTES đầu) cho phép dùng tạm env API_KEY
  const guestApiDeadlineRef = useRef<number>(Date.now() + TRIAL_MINUTES * 60_000);

  // Ngưỡng âm lượng để nhận biết giọng nói (RMS). Giá trị thấp hơn => nhạy hơn.
  const volumeThreshold = 0.0007;

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

  // Lưu user & session vào localStorage
  useEffect(() => {
    try {
      localStorage.setItem('bm_greeter_users', JSON.stringify(users));
    } catch {}
  }, [users]);

  useEffect(() => {
    try {
      if (currentUser) localStorage.setItem('bm_greeter_session', JSON.stringify(currentUser));
      else localStorage.removeItem('bm_greeter_session');
    } catch {}
  }, [currentUser]);

  // Khi user đăng nhập với gói TRIAL lần đầu trên thiết bị này, đánh dấu đã dùng thử
  useEffect(() => {
    if (currentUser && currentUser.plan === 'TRIAL' && !hasUsedTrialOnDevice) {
      try {
        localStorage.setItem('bm_greeter_trial_used', 'true');
        setHasUsedTrialOnDevice(true);
      } catch {}
    }
  }, [currentUser, hasUsedTrialOnDevice]);

  // Lưu API key người dùng nhập
  useEffect(() => {
    try {
      if (customApiKey) {
        localStorage.setItem('bm_greeter_api_key', customApiKey);
      } else {
        localStorage.removeItem('bm_greeter_api_key');
      }
    } catch {}
  }, [customApiKey]);

  // Ẩn thông báo dùng thử sau TRIAL_MINUTES
  useEffect(() => {
    if (!showTrialNotice) return;
    const timer = window.setTimeout(() => {
      setShowTrialNotice(false);
    }, TRIAL_MINUTES * 60_000);
    return () => window.clearTimeout(timer);
  }, [showTrialNotice]);

  // Lưu IP cảm biến chuyển động
  useEffect(() => {
    try {
      if (motionSensorIp) {
        localStorage.setItem('bm_motion_sensor_ip', motionSensorIp);
      } else {
        localStorage.removeItem('bm_motion_sensor_ip');
      }
    } catch {}
  }, [motionSensorIp]);

  // Bắt buộc hiển thị modal đăng nhập sau TRIAL_MINUTES nếu chưa đăng nhập
  useEffect(() => {
    let timer: number | undefined;
    if (!currentUser) {
      timer = window.setTimeout(() => {
        setShowAuthModal(true);
      }, TRIAL_MINUTES * 60_000);
    }
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [currentUser]);

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

  // Poll cảm biến chuyển động (PIR) qua ESP32/ESP8266
  useEffect(() => {
    if (status !== SessionStatus.CONNECTED) return;

    const ip = motionSensorIp || esp32Ip;
    if (!ip) return;

    let cancelled = false;
    let timer: number | undefined;
    let lastTrigger = 0;
    const COOLDOWN_MS = 8000; // không gửi quá dày

    const poll = async () => {
      if (cancelled) return;
      try {
        let base = ip.startsWith('http') ? ip : `http://${ip}`;
        // Đảm bảo có dấu '/'
        if (!base.endsWith('/')) base += '/';
        const url = `${base}motion?t=${Date.now()}`;

        const res = await fetch(url, { method: 'GET' }).catch(() => null);
        if (res && res.ok) {
          const data = await res.json().catch(() => null);
          const motion = data && typeof data.motion === 'boolean' ? data.motion : false;
          const now = Date.now();
          if (motion && now - lastTrigger > COOLDOWN_MS) {
            lastTrigger = now;
            addLog('Cảm biến chuyển động phát hiện khách vào khu vực. Gửi tín hiệu chào khách ngay.', 'info');
            if (activeSessionRef.current) {
              activeSessionRef.current.sendRealtimeInput({
                text: 'Vừa có một khách mới bước vào khu vực cửa hàng. Hãy chào khách thật nhanh, rõ ràng và thân thiện ngay lập tức, không cần chờ khách nói trước.'
              });
            }
          }
        }
      } catch {
        // bỏ qua lỗi kết nối cảm biến
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(poll, 800);
        }
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [status, motionSensorIp, esp32Ip, addLog]);

  // Helper: map planType từ server (TTS) sang PlanType greeter (đơn giản hoá)
  const mapServerPlanToGreeterPlan = (serverPlan: string | undefined): PlanType => {
    if (!serverPlan) return 'TRIAL';
    const p = serverPlan.toUpperCase();
    if (p.includes('YEAR')) return 'YEARLY';
    if (p.includes('MONTH')) return 'MONTHLY';
    return 'TRIAL';
  };

  // Kiểm tra trạng thái thanh toán / gia hạn từ server TTS (tái dùng /api/check_payment)
  const checkPaymentStatus = useCallback(
    async (showLog: boolean = true) => {
      if (!currentUser) return false;
      try {
        const loginId = currentUser.loginId || currentUser.id;
        if (showLog) addLog(`Đang kiểm tra thanh toán cho ${loginId}...`, 'info');

        setIsCheckingPayment(true);
        const res = await fetch(`/api/check_payment/${encodeURIComponent(loginId)}`);
        const data = await res.json();

        if (!data.found || !data.user) {
          if (showLog) addLog('Chưa tìm thấy thông tin thanh toán mới.', 'info');
          setIsCheckingPayment(false);
          return false;
        }

        const serverUser = data.user as any;
        const newExpiry = serverUser.expiryDate as number | undefined;
        const newPlanType = serverUser.planType as string | undefined;

        if (!newExpiry || newExpiry <= currentUser.expiry) {
          if (showLog) {
            addLog(
              'Chưa thấy thay đổi về hạn sử dụng. Thử lại sau vài phút nếu bạn vừa thanh toán.',
              'info'
            );
          }
          setIsCheckingPayment(false);
          return false;
        }

        const mappedPlan = mapServerPlanToGreeterPlan(newPlanType);

        const updated: GreeterUser = {
          ...currentUser,
          plan: mappedPlan,
          expiry: newExpiry,
        };
        setCurrentUser(updated);
        if (showLog) {
          addLog(
            `Đã cập nhật gói ${mappedPlan} • Hạn mới: ${new Date(newExpiry).toLocaleString(
              'vi-VN'
            )}`,
            'success'
          );
        }
        setIsCheckingPayment(false);
        return true;
      } catch (err: any) {
        console.error('checkPaymentStatus error:', err);
        if (showLog) addLog(`Lỗi kiểm tra thanh toán: ${err.message || String(err)}`, 'error');
        setIsCheckingPayment(false);
        return false;
      }
    },
    [currentUser, addLog]
  );

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
      // Yêu cầu quyền với cấu hình audio ưu tiên khử ồn
      await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000
        },
        video: !isVoiceOnly
      });
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
    
    // API Key:
    // - Nếu người dùng đã dán API Key riêng (customApiKey) thì luôn dùng key đó.
    // - Ngược lại, trong 1 phút đầu và khi chưa đăng nhập, cho phép tạm dùng env API_KEY để khách trải nghiệm.
    // - Sau 1 phút (hoặc sau khi đăng nhập), bắt buộc phải có customApiKey.
    let apiKey: string | undefined;
    if (customApiKey) {
      apiKey = customApiKey;
    } else if (!currentUser && Date.now() < guestApiDeadlineRef.current) {
      apiKey = process.env.API_KEY;
    } else {
      apiKey = undefined;
    }

    if (!apiKey) {
      const msg = 'Thiếu API KEY. Vui lòng dán API Key từ Google AI Studio ở phần Cài đặt ➝ Quản lý / Tài khoản.';
      addLog(msg, 'error');
      setPermissionError(msg);
      setStatus(SessionStatus.ERROR);
      return;
    }

    setStatus(SessionStatus.CONNECTING);
    addLog('Đang khởi tạo AI...', 'info');
    
    // Phát hiện thiết bị Bluetooth trước khi kết nối
    addLog('Đang tìm kiếm thiết bị Bluetooth...', 'info');
    const btInfo = await detectBluetoothDevices();
    setBluetoothInfo(btInfo);
    
    if (btInfo.hasBluetooth) {
      const devices: string[] = [];
      if (btInfo.inputDeviceName) devices.push(`Micro: ${btInfo.inputDeviceName}`);
      if (btInfo.outputDeviceName) devices.push(`Loa: ${btInfo.outputDeviceName}`);

      // Log chi tiết theo trường hợp bạn yêu cầu
      const micDesc = btInfo.isInputBluetooth && btInfo.inputDeviceName
        ? `mic Bluetooth ${btInfo.inputDeviceName}`
        : 'mic mặc định của thiết bị';

      const speakerDesc = btInfo.isOutputBluetooth
        ? (btInfo.outputDeviceName
            ? `loa Bluetooth ${btInfo.outputDeviceName}`
            : `loa Bluetooth (thiết bị mặc định hiện tại)`)
        : 'loa mặc định của thiết bị';

      addLog(`Đang dùng ${micDesc}, ${speakerDesc}`, 'info');

      if (devices.length > 0) {
        // Đọc được tên thiết bị rõ ràng (thường là trên desktop)
        addLog(`✓ Thiết bị audio sẽ dùng: ${devices.join(', ')}`, 'success');
      } else {
        // Trường hợp Android WebView / trình duyệt không expose label
        addLog('✓ Hệ thống sẽ dùng thiết bị audio mặc định (nếu đang kết nối loa Bluetooth, âm thanh vẫn ra loa đó).', 'info');
      }

      setShowBluetoothNotification(true);
      // Tự động ẩn thông báo sau 5 giây
      setTimeout(() => setShowBluetoothNotification(false), 5000);
    } else {
      // Chỉ log lỗi khi THẬT SỰ không có thiết bị audio nào
      addLog('Không đọc được bất kỳ thiết bị audio nào – kiểm tra lại kết nối micro/loa.', 'error');
    }
    
    const ai = new GoogleGenAI({ apiKey: apiKey });
    
    // Tạo AudioContext với thiết bị output Bluetooth (nếu có)
    audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    outputAudioContextRef.current = await createAudioContextWithBluetoothOutput(24000, btInfo.outputDevice?.deviceId);
    
    // Thiết lập output device cho AudioContext (nếu trình duyệt hỗ trợ)
    if (btInfo.outputDevice?.deviceId && 'setSinkId' in HTMLAudioElement.prototype) {
      try {
        // Lưu deviceId để sử dụng khi phát audio
        (outputAudioContextRef.current as any).preferredOutputDeviceId = btInfo.outputDevice.deviceId;
      } catch (e) {
        console.warn('Không thể thiết lập thiết bị output Bluetooth:', e);
      }
    }

    const systemInstruction = `
      VAI TRÒ: Bạn là Lễ tân AI thông minh tại cửa hàng Bảo Minh. Bạn đang nhìn qua Camera ${isVoiceOnly ? '(Hiện đang tắt)' : 'ESP32 gắn tại cửa ra vào'} và nghe qua Micro.

      NHIỆM VỤ CHÍNH (QUAN TRỌNG NHẤT):
      1. QUAN SÁT VÀ CHÀO KHÁCH:
         - Nếu KHUNG HÌNH đang trống mà sau đó bạn BẮT ĐẦU THẤY MỘT HOẶC NHIỀU NGƯỜI xuất hiện: Hãy CHÀO NGAY LẬP TỨC, KHÔNG CHỜ KHÁCH NÓI GÌ.
         - Luôn chủ động chào khi thấy khách bước vào, ngay cả khi khách im lặng.
         - Mẫu câu chào: "Dạ Bảo Minh xin chào! Mời anh/chị vào tham quan ạ.", "Xin chào quý khách!", "Chào bạn, mình có thể giúp gì cho bạn không?".
         - Lưu ý: Đừng chào lặp lại liên tục với cùng một người nếu họ chưa rời đi, nhưng nếu khách MỚI xuất hiện sau đó thì vẫn phải chào lại.
      
      2. TRÒ CHUYỆN VÀ TƯ VẤN:
         - Sẵn sàng trả lời các câu hỏi về sản phẩm, giá cả, dịch vụ.
         - Dựa vào danh sách sản phẩm: ${productList || '(Hỏi nhân viên)'}
         - Dựa vào tài liệu cửa hàng: ${storeDocs || ''}
      
      3. PHONG THÁI:
         - Nhanh nhẹn, thân thiện, hiếu khách.
         - Nếu không có ai trong khung hình, hãy giữ im lặng tuyệt đối để tiết kiệm năng lượng.
         - Nhận biết bạn đang sử dụng ESP32 Camera hoặc Webcam, đôi khi hình ảnh có thể trễ một chút, hãy kiên nhẫn.
    `;

    try {
      // Chọn micro theo lựa chọn của người dùng
      let stream: MediaStream;
      if (audioRoute === 'prefer_phone') {
        // Luôn dùng mic mặc định của thiết bị
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
            sampleRate: 16000
          }
        }).catch(e => {
          throw new Error("Lỗi Microphone (mặc định): Vui lòng cấp quyền truy cập âm thanh.");
        });
      } else {
        // AUTO / PREFER_BT: ưu tiên mic Bluetooth nếu có deviceId
        stream = await getUserMediaWithBluetoothPreference(btInfo.inputDevice?.deviceId).catch(e => {
          throw new Error("Lỗi Microphone: Vui lòng cấp quyền truy cập âm thanh.");
        });
      }
      
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
            // Giảm kích thước buffer để giảm độ trễ nhận diện giọng nói
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(1024, 1, 1);
            
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
              
              // Kết nối với destination (hệ thống sẽ tự động chọn thiết bị Bluetooth nếu đã kết nối)
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
         
         let apiKey: string | undefined;
         if (customApiKey) {
           apiKey = customApiKey;
         } else if (!currentUser && Date.now() < guestApiDeadlineRef.current) {
           apiKey = process.env.API_KEY;
         } else {
           apiKey = undefined;
         }
         if(!apiKey) throw new Error("Chưa có API KEY. Vui lòng dán API Key từ Google AI Studio ở phần Cài đặt ➝ Quản lý / Tài khoản.");
         
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

      {/* Thông báo dùng thử 15 phút cho khách */}
      {showTrialNotice && !currentUser && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[180] px-4 py-2 rounded-2xl bg-amber-500/90 text-[10px] font-black uppercase tracking-[0.2em] text-slate-900 shadow-lg flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-600 animate-pulse"></span>
          <span>Dùng thử {TRIAL_MINUTES} phút miễn phí - Sau đó cần đăng nhập & dán API KEY để tiếp tục</span>
        </div>
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

      {/* Modal đăng nhập (Admin / User) */}
      {showAuthModal && (
        <div className="fixed inset-0 z-[210] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-950/90 border border-white/10 rounded-3xl max-w-md w-full p-6 sm:p-8 space-y-5">
            <div className="flex justify-between items-center">
              <h2 className="text-sm sm:text-base font-black text-white uppercase tracking-[0.2em]">
                Đăng nhập quản lý
              </h2>
            </div>
            {authError && (
              <div className="text-[10px] font-bold text-red-400 bg-red-500/10 border border-red-500/40 rounded-2xl px-3 py-2">
                {authError}
              </div>
            )}
            <div className="space-y-3">
              <input
                value={authCreds.loginId}
                onChange={e => setAuthCreds({ ...authCreds, loginId: e.target.value })}
                className="w-full px-4 py-3 rounded-2xl bg-slate-900 border border-white/10 text-[11px] text-slate-100 outline-none focus:border-indigo-500"
                placeholder="Tên đăng nhập"
              />
              <input
                type="password"
                value={authCreds.password}
                onChange={e => setAuthCreds({ ...authCreds, password: e.target.value })}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    // handle auth
                    setAuthError(null);
                    const id = authCreds.loginId.trim().toLowerCase();
                    const pass = authCreds.password;
                    if (!id || !pass) {
                      setAuthError('Vui lòng nhập đầy đủ Tên đăng nhập và Mật khẩu.');
                      return;
                    }
                    if (id === ADMIN_ID.toLowerCase() && pass === ADMIN_PASS) {
                      const adminUser: GreeterUser = {
                        id: 'admin',
                        loginId: ADMIN_ID,
                        password: ADMIN_PASS,
                        name: 'Administrator',
                        role: 'ADMIN',
                        plan: 'YEARLY',
                        expiry: Date.now() + 365 * 24 * 60 * 60 * 1000,
                      };
                      setCurrentUser(adminUser);
                      addLog('Đăng nhập quản trị thành công.', 'success');
                      setShowAuthModal(false);
                      return;
                    }
                    const found = users.find(
                      u =>
                        u.loginId.toLowerCase() === id &&
                        u.password === pass
                    );
                    if (!found) {
                      setAuthError('Sai tài khoản hoặc mật khẩu.');
                      return;
                    }
                    if (found.expiry && found.expiry < Date.now()) {
                      setAuthError('Tài khoản đã hết hạn. Vui lòng liên hệ admin để gia hạn.');
                      return;
                    }
                    setCurrentUser(found);
                    addLog(`Đăng nhập thành công: ${found.loginId}`, 'success');
                    setShowAuthModal(false);
                  }
                }}
                className="w-full px-4 py-3 rounded-2xl bg-slate-900 border border-white/10 text-[11px] text-slate-100 outline-none focus:border-indigo-500"
                placeholder="Mật khẩu"
              />
            </div>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  // cùng logic như Enter
                  setAuthError(null);
                  const id = authCreds.loginId.trim().toLowerCase();
                  const pass = authCreds.password;
                  if (!id || !pass) {
                    setAuthError('Vui lòng nhập đầy đủ Tên đăng nhập và Mật khẩu.');
                    return;
                  }
                  if (id === ADMIN_ID.toLowerCase() && pass === ADMIN_PASS) {
                    const adminUser: GreeterUser = {
                      id: 'admin',
                      loginId: ADMIN_ID,
                      password: ADMIN_PASS,
                      name: 'Administrator',
                      role: 'ADMIN',
                      plan: 'YEARLY',
                      expiry: Date.now() + 365 * 24 * 60 * 60 * 1000,
                    };
                    setCurrentUser(adminUser);
                    addLog('Đăng nhập quản trị thành công.', 'success');
                    setShowAuthModal(false);
                    return;
                  }
                  const found = users.find(
                    u =>
                      u.loginId.toLowerCase() === id &&
                      u.password === pass
                  );
                  if (!found) {
                    setAuthError('Sai tài khoản hoặc mật khẩu.');
                    return;
                  }
                  if (found.expiry && found.expiry < Date.now()) {
                    setAuthError('Tài khoản đã hết hạn. Vui lòng liên hệ admin để gia hạn.');
                    return;
                  }
                  setCurrentUser(found);
                  addLog(`Đăng nhập thành công: ${found.loginId}`, 'success');
                  setShowAuthModal(false);
                }}
                className="w-full py-3 rounded-2xl bg-indigo-600 text-white text-[11px] font-black uppercase tracking-[0.2em] hover:bg-indigo-500"
              >
                Đăng nhập
              </button>
              <p className="text-[9px] text-slate-500 text-center">
                Admin: dùng tài khoản riêng do hệ thống cấp. Người dùng: dùng tài khoản do Admin tạo.
              </p>
              <div className="mt-3 space-y-2 text-[9px] text-slate-300">
                <p className="font-bold text-slate-200 text-center">
                  Chưa có tài khoản?
                </p>
                <div className="flex flex-col sm:flex-row gap-2 justify-center">
                  <button
                    type="button"
                    onClick={() => window.open(ZALO_LINK, '_blank')}
                    className="flex-1 px-3 py-2 rounded-2xl bg-emerald-600 text-white font-black uppercase tracking-[0.2em] hover:bg-emerald-500"
                  >
                    Liên hệ Zalo tạo tài khoản
                  </button>
                  <button
                    type="button"
                    onClick={() => window.open(AI_STUDIO_API_KEY_URL, '_blank')}
                    className="flex-1 px-3 py-2 rounded-2xl bg-slate-800 text-slate-100 font-black uppercase tracking-[0.2em] border border-slate-600 hover:bg-slate-700"
                  >
                    Tạo API Key AI Studio
                  </button>
                </div>
                <div className="flex flex-col items-center gap-1 pt-2">
                  <img
                    src={ZALO_QR_URL}
                    alt="QR Zalo liên hệ 0986 234 983"
                    className="w-24 h-24 rounded-xl bg-white"
                  />
                  <p className="text-[8px] text-slate-500 text-center">
                    Quét QR hoặc nhấn nút Zalo để được cấp tài khoản dùng thử 1 tháng.
                    Mỗi thiết bị chỉ được cấp dùng thử 1 lần.
                  </p>
                  {hasUsedTrialOnDevice && (
                    <p className="text-[8px] text-red-400 text-center font-bold">
                      Thiết bị này đã từng dùng thử. Vui lòng liên hệ để mua gói chính thức.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal bảng điều khiển Admin (đơn giản, lưu localStorage) */}
      {showAdminPanel && currentUser?.role === 'ADMIN' && (
        <div className="fixed inset-0 z-[215] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-950/95 border border-white/10 rounded-3xl max-w-4xl w-full max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
              <div>
                <h2 className="text-xs sm:text-sm font-black text-white uppercase tracking-[0.25em]">
                  Bảng điều khiển Admin
                </h2>
                <p className="text-[10px] text-slate-500">
                  Quản lý tài khoản greeter (lưu cục bộ trên thiết bị này)
                </p>
              </div>
              <button
                onClick={() => {
                  setShowAdminPanel(false);
                  setEditingUser(null);
                }}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              <div className="flex justify-between items-center">
                <h3 className="text-[11px] font-black text-slate-200 uppercase tracking-[0.25em]">
                  Danh sách tài khoản
                </h3>
                <button
                  onClick={() =>
                    setEditingUser({
                      id: `u-${Date.now()}`,
                      loginId: '',
                      password: '',
                      name: '',
                      role: 'USER',
                      plan: 'TRIAL',
                      expiry: Date.now() + PLAN_DURATIONS.TRIAL * 24 * 60 * 60 * 1000,
                    })
                  }
                  className="px-3 py-1.5 rounded-xl bg-emerald-600 text-[10px] font-black uppercase tracking-[0.2em] hover:bg-emerald-500"
                >
                  + Thêm tài khoản
                </button>
              </div>

              {editingUser && (
                <div className="bg-slate-900/80 border border-white/10 rounded-2xl p-4 space-y-3 text-[11px]">
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-slate-100">
                      {editingUser.id === 'new' ? 'Tài khoản mới' : `Sửa: ${editingUser.loginId || '(chưa đặt)'}`}
                    </span>
                    <button
                      onClick={() => setEditingUser(null)}
                      className="text-slate-400 hover:text-slate-100 text-xs"
                    >
                      Đóng
                    </button>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <input
                      value={editingUser.loginId}
                      onChange={e =>
                        setEditingUser({ ...editingUser, loginId: e.target.value })
                      }
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-slate-100 outline-none focus:border-indigo-500"
                      placeholder="Tên đăng nhập"
                    />
                    <input
                      value={editingUser.password}
                      onChange={e =>
                        setEditingUser({ ...editingUser, password: e.target.value })
                      }
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-slate-100 outline-none focus:border-indigo-500"
                      placeholder="Mật khẩu"
                    />
                    <input
                      value={editingUser.name}
                      onChange={e =>
                        setEditingUser({ ...editingUser, name: e.target.value })
                      }
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-slate-100 outline-none focus:border-indigo-500"
                      placeholder="Tên hiển thị"
                    />
                    <select
                      value={editingUser.plan}
                      onChange={e => {
                        const plan = e.target.value as PlanType;
                        setEditingUser({
                          ...editingUser,
                          plan,
                          expiry:
                            editingUser.expiry > Date.now()
                              ? editingUser.expiry
                              : Date.now() + PLAN_DURATIONS[plan] * 24 * 60 * 60 * 1000,
                        });
                      }}
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-slate-100 outline-none focus:border-indigo-500"
                    >
                      <option value="TRIAL">Dùng thử (7 ngày)</option>
                      <option value="MONTHLY">Tháng (30 ngày)</option>
                      <option value="YEARLY">Năm (365 ngày)</option>
                    </select>
                    <input
                      value={editingUser.phone || ''}
                      onChange={e =>
                        setEditingUser({ ...editingUser, phone: e.target.value })
                      }
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-slate-100 outline-none focus:border-indigo-500"
                      placeholder="SĐT (tuỳ chọn)"
                    />
                    <input
                      value={editingUser.note || ''}
                      onChange={e =>
                        setEditingUser({ ...editingUser, note: e.target.value })
                      }
                      className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-white/10 text-slate-100 outline-none focus:border-indigo-500"
                      placeholder="Ghi chú (tuỳ chọn)"
                    />
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-slate-400">
                    <span>
                      Hết hạn:{' '}
                      <span className="font-bold text-slate-100">
                        {new Date(editingUser.expiry).toLocaleString('vi-VN')}
                      </span>
                    </span>
                    <div className="flex gap-2">
                      <button
                        onClick={() =>
                          setEditingUser({
                            ...editingUser,
                            expiry:
                              editingUser.expiry +
                              30 * 24 * 60 * 60 * 1000,
                          })
                        }
                        className="px-2 py-1 rounded-lg bg-emerald-600 text-white"
                      >
                        +30 ngày
                      </button>
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    {editingUser.id !== 'new' && (
                      <button
                        onClick={() => {
                          setUsers(prev =>
                            prev.filter(u => u.id !== editingUser.id)
                          );
                          addLog(
                            `Đã xoá tài khoản ${editingUser.loginId || editingUser.id}`,
                            'success'
                          );
                          setEditingUser(null);
                        }}
                        className="px-3 py-1.5 rounded-xl bg-red-500/20 text-red-300 text-[10px] font-black uppercase tracking-[0.2em] border border-red-500/40"
                      >
                        Xoá
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (!editingUser.loginId || !editingUser.password) {
                          addLog(
                            'Vui lòng nhập Tên đăng nhập và Mật khẩu khi lưu tài khoản.',
                            'error'
                          );
                          return;
                        }
                        setUsers(prev => {
                          const exists = prev.find(u => u.id === editingUser.id);
                          if (exists) {
                            return prev.map(u =>
                              u.id === editingUser.id ? editingUser : u
                            );
                          }
                          return [editingUser, ...prev];
                        });
                        addLog(
                          `Đã lưu tài khoản ${editingUser.loginId}`,
                          'success'
                        );
                        setEditingUser(null);
                      }}
                      className="px-3 py-1.5 rounded-xl bg-indigo-600 text-white text-[10px] font-black uppercase tracking-[0.2em]"
                    >
                      Lưu tài khoản
                    </button>
                  </div>
                </div>
              )}

              <div className="border border-white/10 rounded-2xl overflow-hidden">
                <table className="w-full text-left text-[11px]">
                  <thead className="bg-slate-900/80 text-slate-400 uppercase tracking-[0.2em]">
                    <tr>
                      <th className="px-4 py-3">Tài khoản</th>
                      <th className="px-4 py-3">Gói</th>
                      <th className="px-4 py-3">Hết hạn</th>
                      <th className="px-4 py-3 text-right">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {users.length === 0 && (
                      <tr>
                        <td
                          colSpan={4}
                          className="px-4 py-6 text-center text-[10px] text-slate-500"
                        >
                          Chưa có tài khoản nào. Nhấn “Thêm tài khoản” để tạo.
                        </td>
                      </tr>
                    )}
                    {users.map(u => (
                      <tr key={u.id} className="hover:bg-white/5">
                        <td className="px-4 py-3">
                          <div className="flex flex-col">
                            <span className="font-bold text-slate-100">
                              {u.name || u.loginId}
                            </span>
                            <span className="text-[10px] text-slate-500 font-mono">
                              {u.loginId}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-[10px] font-bold text-indigo-300 uppercase">
                            {u.plan}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-[10px] text-slate-200">
                            {new Date(u.expiry).toLocaleDateString('vi-VN')}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => setEditingUser(u)}
                              className="px-2 py-1 rounded-lg bg-slate-800 text-[10px] text-slate-100"
                            >
                              Sửa
                            </button>
                            <button
                              onClick={() =>
                                setUsers(prev =>
                                  prev.map(x =>
                                    x.id === u.id
                                      ? {
                                          ...x,
                                          expiry:
                                            x.expiry +
                                            30 *
                                              24 *
                                              60 *
                                              60 *
                                              1000,
                                        }
                                      : x
                                  )
                                )
                              }
                              className="px-2 py-1 rounded-lg bg-emerald-600 text-[10px] text-white"
                            >
                              +30 ngày
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal thanh toán / gia hạn bằng QR SePay (chỉ hiển thị QR, không auto-gia-hạn) */}
      {showPaymentModal && currentUser && currentUser.role === 'USER' && (
        <div className="fixed inset-0 z-[220] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-950/95 border border-emerald-400/40 rounded-3xl max-w-md w-full p-6 sm:p-8 space-y-5">
            <div className="flex justify-between items-center">
              <h2 className="text-xs sm:text-sm font-black text-emerald-300 uppercase tracking-[0.25em]">
                Thanh toán / Gia hạn (SePay)
              </h2>
              <button
                onClick={() => setShowPaymentModal(false)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <div className="space-y-3 text-[11px] text-slate-100">
              <p>
                Tài khoản:{' '}
                <span className="font-bold">
                  {currentUser.name} ({currentUser.loginId})
                </span>
              </p>
              <p>
                Gói hiện tại:{' '}
                <span className="font-bold text-indigo-300">{currentUser.plan}</span> •
                Hết hạn:{' '}
                <span className="font-bold">
                  {new Date(currentUser.expiry).toLocaleDateString('vi-VN')}
                </span>
              </p>
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-[0.2em] text-slate-400">
                  Số tiền thanh toán (VNĐ)
                </label>
                <input
                  type="number"
                  min={10000}
                  step={10000}
                  value={paymentAmount || ''}
                  onChange={e =>
                    setPaymentAmount(Number(e.target.value) || 0)
                  }
                  className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-emerald-400/40 text-slate-100 outline-none focus:border-emerald-400"
                  placeholder="Ví dụ: 100000"
                />
              </div>
              {paymentAmount > 0 && (
                <div className="bg-black/40 border border-emerald-400/40 rounded-2xl p-4 flex flex-col items-center gap-3">
                  <img
                    src={getSepayQRUrl(paymentAmount, currentUser.loginId)}
                    alt="QR SePay"
                    className="w-48 h-48 rounded-2xl bg-white"
                  />
                  <p className="text-[10px] text-emerald-200 text-center">
                    Quét QR bằng app ngân hàng để thanh toán. Trong nội dung chuyển
                    khoản luôn có mã{' '}
                    <span className="font-mono font-bold">
                      VT-{currentUser.loginId}
                    </span>{' '}
                    để hệ thống SePay + server TTS tự động nhận diện tài khoản.
                  </p>
                </div>
              )}
              <div className="space-y-2">
                <button
                  onClick={() => checkPaymentStatus(true)}
                  disabled={isCheckingPayment}
                  className={`w-full py-2.5 rounded-xl text-[10px] font-black uppercase tracking-[0.2em] ${
                    isCheckingPayment
                      ? 'bg-slate-700 text-slate-300'
                      : 'bg-emerald-600 text-white hover:bg-emerald-500'
                  }`}
                >
                  {isCheckingPayment ? 'ĐANG KIỂM TRA THANH TOÁN...' : 'ĐÃ CHUYỂN KHOẢN • KIỂM TRA GIA HẠN'}
                </button>
                <p className="text-[9px] text-slate-400">
                  Hệ thống backend (SePay Webhook + Postgres) đang được tái sử dụng từ
                  Bảo Minh AI TTS. Sau khi chuyển khoản thành công, bấm nút trên để
                  đồng bộ hạn sử dụng mới cho tài khoản greeter này.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {showBluetoothNotification && bluetoothInfo && bluetoothInfo.hasBluetooth && (
        <div className="fixed top-4 right-4 z-[190] bg-indigo-600/90 backdrop-blur-md border border-indigo-400/50 rounded-2xl p-4 sm:p-6 shadow-2xl shadow-indigo-500/30 animate-[fadeIn_0.3s_ease-out] max-w-sm">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 sm:w-12 sm:h-12 bg-indigo-500/30 rounded-xl flex items-center justify-center flex-shrink-0 border border-indigo-400/50">
              <svg className="w-6 h-6 sm:w-7 sm:h-7 text-indigo-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm sm:text-base font-black text-white uppercase tracking-tight mb-1">Đã phát hiện Bluetooth</h3>
              <div className="space-y-1 text-xs sm:text-sm text-indigo-100">
                {bluetoothInfo.inputDeviceName && (
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                    <span className="truncate">{bluetoothInfo.inputDeviceName}</span>
                  </div>
                )}
                {bluetoothInfo.outputDeviceName && (
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    </svg>
                    <span className="truncate">{bluetoothInfo.outputDeviceName}</span>
                  </div>
                )}
                <div className="mt-3 space-y-1">
                  <p className="text-[10px] text-indigo-100/80 font-semibold uppercase tracking-widest">
                    Chọn đường âm thanh
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => {
                        setAudioRoute('prefer_bluetooth');
                        addLog('Người dùng chọn ưu tiên loa/mic Bluetooth. Hãy đảm bảo Android đang route âm thanh ra loa Bluetooth.', 'info');
                      }}
                      className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest border transition-all ${
                        audioRoute === 'prefer_bluetooth'
                          ? 'bg-emerald-500 text-white border-emerald-300 shadow shadow-emerald-400/40'
                          : 'bg-indigo-500/40 text-indigo-100 border-indigo-300/60 hover:bg-indigo-500/70'
                      }`}
                    >
                      Ưu tiên Bluetooth
                    </button>
                    <button
                      onClick={() => {
                        setAudioRoute('prefer_phone');
                        addLog('Người dùng chọn ưu tiên loa/mic mặc định của điện thoại.', 'info');
                      }}
                      className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest border transition-all ${
                        audioRoute === 'prefer_phone'
                          ? 'bg-slate-900 text-white border-slate-200 shadow shadow-slate-900/40'
                          : 'bg-slate-900/40 text-slate-100 border-slate-200/50 hover:bg-slate-900/70'
                      }`}
                    >
                      Loa điện thoại
                    </button>
                    <button
                      onClick={() => {
                        setAudioRoute('auto');
                        addLog('Người dùng chọn chế độ tự động: ưu tiên Bluetooth nếu có, nếu không thì dùng mặc định.', 'info');
                      }}
                      className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-widest border transition-all ${
                        audioRoute === 'auto'
                          ? 'bg-white/10 text-white border-white/70'
                          : 'bg-white/5 text-indigo-50 border-white/40 hover:bg-white/15'
                      }`}
                    >
                      Tự động
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <button 
              onClick={() => setShowBluetoothNotification(false)} 
              className="text-indigo-200 hover:text-white transition-colors flex-shrink-0 p-1"
              aria-label="Đóng"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
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
                  <div className="bg-orange-500/5 border border-orange-500/10 rounded-xl p-4 space-y-3 animate-[fadeIn_0.2s_ease-out] mt-3">
                    <p className="text-[8px] text-orange-400 uppercase font-black tracking-widest">IP ESP32 CAM / STREAM URL</p>
                    <p className="text-[8px] text-slate-500 mb-2">Nhập IP (VD: 192.168.1.9) hoặc URL stream MJPEG</p>
                    <input 
                      type="text" 
                      value={esp32Ip} 
                      onChange={(e) => setEsp32Ip(e.target.value)} 
                      placeholder="Nhập IP ESP32..." 
                      className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-3 text-sm text-orange-200 focus:outline-none focus:border-orange-500/50 font-mono" 
                    />
                    <div className="space-y-1 pt-1">
                      <p className="text-[8px] text-slate-400">
                        Nếu bạn gắn cảm biến chuyển động (PIR) vào một ESP32/ESP8266 khác, hãy nhập IP riêng bên dưới.
                        Nếu để trống, hệ thống sẽ dùng chung IP ESP32 Cam cho cảm biến chuyển động.
                      </p>
                      <input 
                        type="text"
                        value={motionSensorIp}
                        onChange={(e) => setMotionSensorIp(e.target.value)}
                        placeholder="IP cảm biến chuyển động (ESP32 PIR) - VD: 192.168.1.10"
                        className="w-full bg-black/40 border border-emerald-500/40 rounded-lg px-4 py-3 text-sm text-emerald-200 focus:outline-none focus:border-emerald-400 font-mono" 
                      />
                    </div>
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

              <div className="space-y-4 pt-4 border-t border-white/10">
                <label className="text-[8px] sm:text-[10px] font-black text-slate-500 uppercase tracking-widest">QUẢN LÝ / TÀI KHOẢN</label>
                <div className="bg-black/30 border border-white/10 rounded-2xl p-4 space-y-3 text-[10px] text-slate-300">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-bold text-xs text-white">
                        {currentUser ? currentUser.name : 'Chưa đăng nhập'}
                      </p>
                      <p className="text-[9px] text-slate-500">
                        {currentUser 
                          ? currentUser.role === 'ADMIN' 
                            ? 'Quyền: Quản trị' 
                            : `Tài khoản: ${currentUser.loginId} • Gói: ${currentUser.plan}`
                          : 'Đăng nhập để quản lý & gia hạn'}
                      </p>
                    </div>
                    {currentUser && (
                      <button
                        onClick={() => {
                          setCurrentUser(null);
                          addLog('Người dùng đã đăng xuất khỏi hệ thống quản lý.', 'info');
                          setShowAuthModal(true);
                        }}
                        className="px-2 py-1 rounded-lg bg-slate-800 text-[9px] font-bold uppercase tracking-widest border border-slate-600 hover:bg-slate-700"
                      >
                        Đăng xuất
                      </button>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {!currentUser && (
                      <button
                        onClick={() => {
                          setAuthError(null);
                          setShowAuthModal(true);
                        }}
                        className="px-3 py-1.5 rounded-xl bg-indigo-600 text-white text-[9px] font-black uppercase tracking-widest hover:bg-indigo-500"
                      >
                        Đăng nhập / Quản trị
                      </button>
                    )}
                    {currentUser?.role === 'ADMIN' && (
                      <button
                        onClick={() => setShowAdminPanel(true)}
                        className="px-3 py-1.5 rounded-xl bg-amber-500/20 text-amber-300 text-[9px] font-black uppercase tracking-widest border border-amber-400/60 hover:bg-amber-500/40"
                      >
                        Bảng điều khiển Admin
                      </button>
                    )}
                    {currentUser && currentUser.role === 'USER' && (
                      <button
                        onClick={() => {
                          setPaymentAmount(100000); // mặc định 100k, admin có thể hướng dẫn đổi sau
                          setShowPaymentModal(true);
                        }}
                        className="px-3 py-1.5 rounded-xl bg-emerald-600 text-white text-[9px] font-black uppercase tracking-widest hover:bg-emerald-500"
                      >
                        Thanh toán / Gia hạn (SePay)
                      </button>
                    )}
                  </div>
                  <div className="mt-3 space-y-1">
                    <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest">
                      API KEY GOOGLE AI STUDIO
                    </p>
                    <input
                      type="password"
                      value={customApiKey}
                      onChange={e => setCustomApiKey(e.target.value.trim())}
                      className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-white/10 text-[10px] text-slate-100 outline-none focus:border-indigo-500 font-mono"
                      placeholder="Dán API Key bạn vừa tạo tại aistudio.google.com/app/apikey"
                    />
                    <p className="text-[8px] text-slate-500">
                      Trong 1 phút đầu, nếu bạn chưa dán API Key thì hệ thống sẽ dùng tạm API KEY mặc định để khách
                      trải nghiệm. Sau 1 phút hoặc sau khi đăng nhập, BẮT BUỘC phải dán API Key riêng thì mới tiếp tục dùng được.
                    </p>
                  </div>
                </div>
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