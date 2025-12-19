
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { SessionStatus, TranscriptionEntry } from './types';
import { decode, decodeAudioData, createBlob } from './utils';
import { VoiceVisualizer } from './components/VoiceVisualizer';

const SYSTEM_INSTRUCTION = `
You are the "Neural Polyglot Assistant." 
Your workflow is strictly as follows:
1. RECORDING PHASE: You listen silently while the user speaks.
2. CONFIRMATION & OPTIONS: Immediately after the user finishes their phrase, you must say: "I've recorded that. Would you like me to translate it into Urdu, Telugu, Hindi, Kannada, Tamil, or any other language?"
3. TRANSLATION PHASE: Once they provide a language name (e.g., "Telugu"), you perform the translation using a native-quality voice.
4. FOLLOW-UP: After translating, ask: "Would you like another language for this same phrase, or should we record a new one?"

You support all global languages but prioritize listing Urdu, Telugu, Hindi, Kannada, and Tamil as the primary options. Be professional, sophisticated, and act as a high-end AI dashboard.
`;

const VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'];
const INDIAN_LANGUAGES = ['Urdu', 'Telugu', 'Hindi', 'Kannada', 'Tamil'];

const GOOGLE_ACCOUNTS = [
  { name: 'Alex Thompson', email: 'alex.thompson@gmail.com', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Alex' },
  { name: 'Developer User', email: 'dev.workspace@gmail.com', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Dev' },
  { name: 'Guest Translator', email: 'guest.access@gmail.com', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Guest' },
];

const App: React.FC = () => {
  const [authStep, setAuthStep] = useState<'LOGIN' | 'SELECT_ACCOUNT' | 'DASHBOARD'>('LOGIN');
  const [userProfile, setUserProfile] = useState<{name: string, email: string, avatar: string} | null>(null);
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.IDLE);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedVoice, setSelectedVoice] = useState('Kore');
  const [hasRecorded, setHasRecorded] = useState(false);
  
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const transcriptionBufferRef = useRef({ input: '', output: '' });
  const streamRef = useRef<MediaStream | null>(null);

  const cleanup = useCallback(() => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    activeSourcesRef.current.clear();
    
    if (audioContextInRef.current) {
      audioContextInRef.current.close().catch(() => {});
      audioContextInRef.current = null;
    }
    if (audioContextOutRef.current) {
      audioContextOutRef.current.close().catch(() => {});
      audioContextOutRef.current = null;
    }

    setStatus(SessionStatus.IDLE);
    setIsModelSpeaking(false);
    setHasRecorded(false);
  }, []);

  const handleStopSession = useCallback(() => {
    cleanup();
  }, [cleanup]);

  const handleStartSession = async () => {
    setErrorMessage(null);
    try {
      setStatus(SessionStatus.CONNECTING);
      
      // Initialize Audio Contexts
      const audioContextIn = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const audioContextOut = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      // Ensure contexts are resumed (crucial for mic input)
      await audioContextIn.resume();
      await audioContextOut.resume();
      
      audioContextInRef.current = audioContextIn;
      audioContextOutRef.current = audioContextOut;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } },
          },
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(SessionStatus.CONNECTED);
            
            const source = audioContextIn.createMediaStreamSource(stream);
            const scriptProcessor = audioContextIn.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                // Only send if session is still active
                if (session) {
                  session.sendRealtimeInput({ media: pcmBlob });
                }
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextIn.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              transcriptionBufferRef.current.input += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              transcriptionBufferRef.current.output += message.serverContent.outputTranscription.text;
            }
            
            if (message.serverContent?.turnComplete) {
              const input = transcriptionBufferRef.current.input;
              const output = transcriptionBufferRef.current.output;
              if (input.trim()) {
                setTranscriptions(prev => [...prev, { role: 'user', text: input, timestamp: Date.now() }]);
                setHasRecorded(true); // Triggers the language menu
              }
              if (output.trim()) {
                setTranscriptions(prev => [...prev, { role: 'model', text: output, timestamp: Date.now() }]);
              }
              transcriptionBufferRef.current = { input: '', output: '' };
            }

            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              setIsModelSpeaking(true);
              const ctx = audioContextOutRef.current;
              if (ctx) {
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
                const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
                const source = ctx.createBufferSource();
                source.buffer = buffer;
                source.connect(ctx.destination);
                source.onended = () => {
                  activeSourcesRef.current.delete(source);
                  if (activeSourcesRef.current.size === 0) setIsModelSpeaking(false);
                };
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += buffer.duration;
                activeSourcesRef.current.add(source);
              }
            }

            if (message.serverContent?.interrupted) {
              activeSourcesRef.current.forEach(s => { try { s.stop(); } catch(e){} });
              activeSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsModelSpeaking(false);
            }
          },
          onerror: (err: any) => {
            console.error("Session Error:", err);
            setStatus(SessionStatus.ERROR);
            setErrorMessage("Voice interface link failed.");
          },
          onclose: (e: any) => {
            console.log("Session Closed:", e);
            cleanup();
          }
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (error: any) {
      console.error("Init Error:", error);
      setStatus(SessionStatus.ERROR);
      setErrorMessage("Microphone access denied or connection failed.");
    }
  };

  const handleLanguageSelect = (lang: string) => {
    if (sessionRef.current) {
      sessionRef.current.sendRealtimeInput({
        text: `Translate that to ${lang}`
      });
    }
  };

  const selectAccount = (account: typeof GOOGLE_ACCOUNTS[0]) => {
    setUserProfile(account);
    setAuthStep('DASHBOARD');
  };

  const handleLogout = () => {
    cleanup();
    setUserProfile(null);
    setAuthStep('LOGIN');
  };

  // --- Auth Screens ---
  if (authStep === 'LOGIN') {
    return (
      <div className="min-h-screen bg-[#020617] flex flex-col items-center justify-center p-6 text-center overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-indigo-600/10 blur-[150px] rounded-full" />
          <div className="absolute bottom-[-20%] right-[-10%] w-[60%] h-[60%] bg-blue-600/10 blur-[150px] rounded-full" />
        </div>
        <div className="relative z-10 w-full max-w-sm space-y-8 animate-in fade-in zoom-in duration-500">
          <div className="w-24 h-24 bg-gradient-to-tr from-indigo-500 to-violet-600 rounded-[2.5rem] flex items-center justify-center shadow-[0_0_50px_rgba(99,102,241,0.5)] mx-auto">
            <svg className="w-12 h-12 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
          <div className="space-y-2">
            <h1 className="text-4xl font-black tracking-tighter text-white">Polyglot</h1>
            <p className="text-slate-400 text-sm font-medium">Neural Voice Translation Hub</p>
          </div>
          <button 
            onClick={() => setAuthStep('SELECT_ACCOUNT')}
            className="w-full py-4 px-6 bg-white hover:bg-slate-100 text-slate-900 font-bold rounded-2xl flex items-center justify-center gap-4 transition-all shadow-xl active:scale-[0.98]"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.66l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  if (authStep === 'SELECT_ACCOUNT') {
    return (
      <div className="min-h-screen bg-[#020617] flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-white rounded-[2.5rem] overflow-hidden shadow-[0_20px_60px_rgba(0,0,0,0.4)] animate-in slide-in-from-bottom-8 duration-500">
          <div className="p-10 text-center space-y-4">
            <svg className="w-12 h-12 mx-auto" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.66l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            <h2 className="text-2xl font-black text-slate-900 tracking-tight">Choose Account</h2>
          </div>
          <div className="border-t border-slate-50">
            {GOOGLE_ACCOUNTS.map((acc) => (
              <button 
                key={acc.email}
                onClick={() => selectAccount(acc)}
                className="w-full flex items-center gap-4 p-6 text-left hover:bg-slate-50 transition-colors border-b border-slate-50 last:border-0 group"
              >
                <img src={acc.avatar} alt={acc.name} className="w-12 h-12 rounded-full border-2 border-slate-100 group-hover:border-indigo-400 transition-colors" />
                <div className="flex-grow">
                  <p className="font-bold text-slate-900 text-sm">{acc.name}</p>
                  <p className="text-slate-500 text-xs font-medium">{acc.email}</p>
                </div>
              </button>
            ))}
          </div>
          <div className="p-6 bg-slate-50/50 text-center">
             <button onClick={() => setAuthStep('LOGIN')} className="text-slate-400 text-[10px] font-black hover:text-indigo-600 uppercase tracking-[0.2em]">Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  // --- Dashboard ---
  return (
    <div className="min-h-screen bg-[#020617] text-slate-100 flex flex-col font-inter overflow-hidden relative">
      {/* Background Glow */}
      <div className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[100%] h-[100%] transition-all duration-1000 ${status === SessionStatus.CONNECTED ? 'bg-indigo-600/5' : 'bg-transparent'} blur-[200px] rounded-full pointer-events-none`} />

      {/* Nav */}
      <nav className="relative z-50 px-8 py-4 bg-slate-950/60 backdrop-blur-2xl border-b border-white/5 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-indigo-500/20 shadow-lg">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
          <h1 className="text-sm font-black tracking-widest uppercase hidden sm:block">Polyglot Pro</h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 px-3 py-1.5 bg-white/5 rounded-2xl border border-white/5">
            <img src={userProfile?.avatar} className="w-6 h-6 rounded-full border border-white/10" alt="User" />
            <div className="text-right">
              <p className="text-[10px] font-black leading-none">{userProfile?.name}</p>
              <button onClick={handleLogout} className="text-[8px] text-slate-500 hover:text-red-400 font-bold uppercase tracking-widest transition-colors">Logout</button>
            </div>
          </div>
        </div>
      </nav>

      <main className="flex-grow flex flex-col items-center justify-center p-6 relative z-10">
        <div className="max-w-4xl w-full flex flex-col items-center gap-12">
          
          {/* Main Control Center */}
          <div className="flex flex-col items-center gap-8 w-full animate-in fade-in slide-in-from-bottom-8 duration-700">
            <div className="relative">
              {status === SessionStatus.CONNECTED && (
                <div className="absolute inset-0 -m-6 bg-indigo-500/20 rounded-full animate-ping opacity-20 pointer-events-none" />
              )}
              
              <button
                onClick={status === SessionStatus.CONNECTED ? handleStopSession : handleStartSession}
                disabled={status === SessionStatus.CONNECTING}
                className={`w-40 h-40 rounded-full flex items-center justify-center transition-all duration-500 shadow-[0_20px_60px_rgba(0,0,0,0.5)] relative z-10 border-4 ${
                  status === SessionStatus.CONNECTED 
                    ? 'bg-red-500 border-red-400 hover:bg-red-600 scale-110 active:scale-105' 
                    : 'bg-indigo-600 border-indigo-500 hover:bg-indigo-500 scale-100 hover:scale-105 active:scale-95 shadow-indigo-500/30'
                } disabled:opacity-50 group`}
              >
                {status === SessionStatus.CONNECTING ? (
                  <div className="w-12 h-12 border-4 border-white/30 border-t-white rounded-full animate-spin" />
                ) : status === SessionStatus.CONNECTED ? (
                  <svg className="w-14 h-14 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                ) : (
                  <svg className="w-14 h-14 text-white group-hover:scale-110 transition-transform" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                    <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
                  </svg>
                )}
              </button>
            </div>

            <div className="w-full max-w-lg text-center space-y-4">
              <VoiceVisualizer isActive={status === SessionStatus.CONNECTED} isModelSpeaking={isModelSpeaking} />
              <div className="h-4">
                {errorMessage ? (
                  <p className="text-red-400 text-[10px] font-black uppercase tracking-widest animate-pulse">{errorMessage}</p>
                ) : (
                  <p className="text-slate-500 text-[10px] font-black uppercase tracking-[0.6em]">
                    {status === SessionStatus.CONNECTED 
                      ? (isModelSpeaking ? "Neural Processing..." : "Ready to Translate") 
                      : "Tap to establish connection"}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Languages Menu - Appears when transcription is captured */}
          <div className={`w-full max-w-3xl transition-all duration-700 transform ${hasRecorded && status === SessionStatus.CONNECTED ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-12 scale-95 pointer-events-none'}`}>
            <div className="bg-slate-900/40 backdrop-blur-3xl border border-white/10 p-10 rounded-[3.5rem] shadow-2xl relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-indigo-500/50 to-transparent" />
              <h2 className="text-center text-[12px] font-black uppercase tracking-[0.4em] text-indigo-400 mb-10">Select Target Language</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
                {INDIAN_LANGUAGES.map(lang => (
                  <button
                    key={lang}
                    onClick={() => handleLanguageSelect(lang)}
                    className="group flex flex-col items-center gap-4 p-5 rounded-[2rem] bg-white/5 border border-white/5 hover:bg-indigo-600 hover:border-indigo-400 transition-all active:scale-95 hover:-translate-y-1"
                  >
                    <div className="w-12 h-12 rounded-2xl bg-white/10 flex items-center justify-center text-xl font-bold group-hover:bg-white/20 transition-colors shadow-lg">
                      {lang[0]}
                    </div>
                    <span className="text-[10px] font-black uppercase tracking-widest">{lang}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Recent Transcriptions - Floating bubbles */}
          <div className="w-full max-w-2xl flex flex-col gap-3 px-4 max-h-[160px] overflow-y-auto scrollbar-hide opacity-60">
            {transcriptions.slice(-3).reverse().map((t, i) => (
              <div key={i} className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2`}>
                <div className={`px-5 py-2.5 rounded-2xl text-[11px] font-medium tracking-wide ${t.role === 'user' ? 'bg-indigo-500/10 text-indigo-200 border border-indigo-500/20' : 'bg-slate-800 text-slate-400 border border-white/5'}`}>
                  {t.text}
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* Side Voice Settings */}
      <div className="fixed bottom-10 left-10 hidden xl:flex flex-col gap-3 group">
         <span className="text-[9px] font-black text-slate-700 uppercase tracking-[0.3em] ml-2">Synthesis Aura</span>
         <div className="flex flex-col gap-1.5 p-3 bg-slate-900/60 backdrop-blur-xl rounded-[2rem] border border-white/10 shadow-2xl">
           {VOICES.map(v => (
             <button 
               key={v}
               onClick={() => setSelectedVoice(v)}
               className={`px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all ${selectedVoice === v ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'}`}
             >
               {v}
             </button>
           ))}
         </div>
      </div>

      <footer className="px-10 py-5 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between text-[10px] text-slate-700 font-black uppercase tracking-[0.4em] bg-slate-950/20 gap-4">
        <div className="flex items-center gap-10">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${status === SessionStatus.CONNECTED ? 'bg-green-500 shadow-[0_0_8px_#22c55e]' : 'bg-slate-800'}`} />
            <span>Connection: {status}</span>
          </div>
          <span className="opacity-20 hidden sm:inline">|</span>
          <span>Sample Rate: 16k Input / 24k Output</span>
        </div>
        <div className="flex items-center gap-6 text-slate-800">
           <span>Neural Core v2.5</span>
           <span>Polyglot Protocol Active</span>
        </div>
      </footer>
    </div>
  );
};

export default App;
