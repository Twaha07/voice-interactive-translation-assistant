
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { SessionStatus, TranscriptionEntry } from './types';
import { decode, encode, decodeAudioData, createBlob } from './utils';
import { VoiceVisualizer } from './components/VoiceVisualizer';

const SYSTEM_INSTRUCTION = `
You are the "Universal Polyglot Voice Menu." You support EVERY language globally.
Your core workflow is strictly menu-driven:
1. CAPTURE & CONFIRM: As soon as the user speaks, transcribe it and say: "I captured that as: '[text]'. What language would you like me to translate this into?"
2. MENU PRESENTATION: List a few popular options (Spanish, French, Mandarin, Hindi, Arabic, German, Japanese, Portuguese, Russian) but state clearly: "I can translate into ANY language in the world. Just name it."
3. EXECUTION: Once the user specifies a language, provide a high-quality, native-sounding translation.
4. FOLLOW-UP: After translating, ask: "Would you like to try another language for this same phrase, or shall we start a new one?"

Always maintain a professional, helpful, and clear tone. Use the specific native accent for the target translation.
`;

const App: React.FC = () => {
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.IDLE);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const transcriptionBufferRef = useRef({ input: '', output: '' });
  const streamRef = useRef<MediaStream | null>(null);

  // Mandatory check for API key
  useEffect(() => {
    const checkKey = async () => {
      try {
        const selected = await (window as any).aistudio.hasSelectedApiKey();
        setHasKey(selected);
      } catch (e) {
        console.error("Key check failed", e);
        setHasKey(false);
      }
    };
    checkKey();
  }, []);

  const handleSelectKey = async () => {
    try {
      await (window as any).aistudio.openSelectKey();
      setHasKey(true); // Assume success per instructions
      setErrorMessage(null);
    } catch (e) {
      console.error("Key selection failed", e);
    }
  };

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
    setStatus(SessionStatus.IDLE);
    setIsModelSpeaking(false);
  }, []);

  const handleStartSession = async () => {
    setErrorMessage(null);
    if (!hasKey) {
      handleSelectKey();
      return;
    }

    try {
      setStatus(SessionStatus.CONNECTING);
      
      // Initialize Audio Contexts
      audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      // Request Microphone
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Initialize Gemini Live
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(SessionStatus.CONNECTED);
            const source = audioContextInRef.current!.createMediaStreamSource(streamRef.current!);
            const scriptProcessor = audioContextInRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                if (session) {
                  session.sendRealtimeInput({ media: pcmBlob });
                }
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle transcribing user and model
            if (message.serverContent?.inputTranscription) {
              transcriptionBufferRef.current.input += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              transcriptionBufferRef.current.output += message.serverContent.outputTranscription.text;
            }
            
            if (message.serverContent?.turnComplete) {
              const input = transcriptionBufferRef.current.input;
              const output = transcriptionBufferRef.current.output;
              if (input.trim()) setTranscriptions(prev => [...prev, { role: 'user', text: input, timestamp: Date.now() }]);
              if (output.trim()) setTranscriptions(prev => [...prev, { role: 'model', text: output, timestamp: Date.now() }]);
              transcriptionBufferRef.current = { input: '', output: '' };
            }

            // Playback generated audio
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              setIsModelSpeaking(true);
              const ctx = audioContextOutRef.current!;
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

            if (message.serverContent?.interrupted) {
              activeSourcesRef.current.forEach(s => { try { s.stop(); } catch(e){} });
              activeSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsModelSpeaking(false);
            }
          },
          onerror: (err: any) => {
            console.error('Session error:', err);
            if (err?.message?.includes('Requested entity was not found')) {
              setErrorMessage("Invalid Project or Key. Re-selecting...");
              handleSelectKey();
            } else {
              setErrorMessage(err?.message || "An unexpected error occurred.");
            }
            setStatus(SessionStatus.ERROR);
          },
          onclose: () => {
            cleanup();
          }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (error: any) {
      console.error('Initialization failed:', error);
      setStatus(SessionStatus.ERROR);
      if (error?.message?.includes('Requested entity was not found')) {
        handleSelectKey();
      } else {
        setErrorMessage("Microphone access or connection failed.");
      }
    }
  };

  const handleStopSession = () => {
    cleanup();
  };

  const handleSaveConversation = () => {
    if (transcriptions.length === 0) return;
    setIsSaving(true);
    
    try {
      const content = transcriptions.map(t => {
        const time = new Date(t.timestamp).toLocaleTimeString();
        const role = t.role === 'user' ? 'YOU' : 'ASSISTANT';
        return `[${time}] ${role}:\n${t.text}\n`;
      }).join('\n');

      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `translation-history-${new Date().toISOString().split('T')[0]}.txt`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setTimeout(() => setIsSaving(false), 1000);
    }
  };

  return (
    <div className="min-h-screen bg-[#020617] text-slate-100 flex flex-col font-inter">
      {/* Decorative background elements */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none opacity-20">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-500 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-600 blur-[120px] rounded-full" />
      </div>

      {/* Nav */}
      <nav className="relative z-10 w-full px-6 py-4 border-b border-slate-800/50 bg-slate-950/50 backdrop-blur-md">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-br from-indigo-500 to-blue-600 rounded-xl shadow-lg">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
              </svg>
            </div>
            <span className="font-bold text-lg tracking-tight">Polyglot Menu</span>
          </div>
          
          <div className="flex items-center gap-4">
            {status === SessionStatus.CONNECTED ? (
              <span className="flex items-center gap-2 text-xs font-semibold text-green-400 bg-green-400/10 px-3 py-1 rounded-full border border-green-400/20">
                <span className="w-2 h-2 bg-green-500 rounded-full animate-ping" />
                Live: Mic Active
              </span>
            ) : (
              <span className="text-xs font-medium text-slate-500">System Ready</span>
            )}
          </div>
        </div>
      </nav>

      <main className="relative z-10 flex-grow max-w-6xl w-full mx-auto p-4 md:p-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Controls Panel */}
        <div className="lg:col-span-4 space-y-6">
          <section className="bg-slate-900/60 border border-slate-800 p-6 rounded-[2rem] shadow-2xl backdrop-blur-sm">
            <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-6">Voice Control</h2>
            
            <div className="mb-8">
              <VoiceVisualizer isActive={status === SessionStatus.CONNECTED} isModelSpeaking={isModelSpeaking} />
            </div>

            {!hasKey && (
              <div className="mb-6 p-4 bg-amber-500/10 border border-amber-500/30 rounded-2xl">
                <p className="text-xs text-amber-200/80 mb-3 leading-relaxed font-medium">
                  Authentication required. Project billing must be enabled for Gemini 2.5 models.
                </p>
                <button 
                  onClick={handleSelectKey}
                  className="w-full py-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded-xl transition-all shadow-lg shadow-amber-600/20"
                >
                  Configure API Key
                </button>
              </div>
            )}

            {errorMessage && (
              <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-2xl">
                <p className="text-xs text-red-400 font-medium leading-relaxed">{errorMessage}</p>
              </div>
            )}

            <div className="space-y-4">
              {status === SessionStatus.CONNECTED ? (
                <button
                  onClick={handleStopSession}
                  className="w-full py-4 bg-red-500/10 hover:bg-red-500/20 border border-red-500/40 transition-all rounded-2xl font-bold text-red-400 flex items-center justify-center gap-3 group"
                >
                  <div className="w-2 h-2 bg-red-500 rounded-full group-hover:scale-125 transition-transform" />
                  Stop Recording
                </button>
              ) : (
                <button
                  onClick={handleStartSession}
                  disabled={status === SessionStatus.CONNECTING || !hasKey}
                  className="w-full py-5 bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 disabled:opacity-30 disabled:grayscale transition-all rounded-2xl font-bold text-white flex items-center justify-center gap-3 shadow-xl shadow-indigo-600/30 group active:scale-95"
                >
                  {status === SessionStatus.CONNECTING ? (
                    <div className="flex gap-1.5 items-center">
                      <div className="w-2 h-2 bg-white rounded-full animate-bounce" />
                      <div className="w-2 h-2 bg-white rounded-full animate-bounce [animation-delay:0.2s]" />
                      <div className="w-2 h-2 bg-white rounded-full animate-bounce [animation-delay:0.4s]" />
                    </div>
                  ) : (
                    <>
                      <svg className="w-6 h-6 group-hover:scale-110 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                      </svg>
                      Start Translation
                    </>
                  )}
                </button>
              )}
            </div>
            
            <div className="mt-8 pt-6 border-t border-slate-800/50">
              <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em] mb-4 text-center">How it works</h3>
              <div className="flex justify-between gap-2">
                {[
                  { step: "1", label: "Speak" },
                  { step: "2", label: "Pick Lang" },
                  { step: "3", label: "Result" }
                ].map((s, i) => (
                  <div key={i} className="flex flex-col items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-[10px] font-bold">
                      {s.step}
                    </div>
                    <span className="text-[9px] text-slate-500 font-bold uppercase">{s.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="p-6 bg-slate-900/40 rounded-3xl border border-slate-800/50">
             <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">Global Menu</h3>
             <p className="text-[11px] text-slate-400 leading-relaxed italic">
               The system is programmed to support every language including Arabic, Hindi, Japanese, Swahili, Tamil, and more. Just say the language name when prompted.
             </p>
          </section>
        </div>

        {/* Conversation Feed */}
        <div className="lg:col-span-8 flex flex-col min-h-[500px]">
          <div className="bg-slate-900/60 border border-slate-800 rounded-[2rem] flex-grow flex flex-col shadow-2xl backdrop-blur-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/80">
              <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest">Transcription Feed</h2>
              <div className="flex items-center gap-4">
                {transcriptions.length > 0 && (
                  <>
                    <button 
                      onClick={handleSaveConversation}
                      disabled={isSaving}
                      className={`text-xs font-bold transition-all uppercase tracking-widest flex items-center gap-2 ${isSaving ? 'text-green-400' : 'text-slate-400 hover:text-indigo-400'}`}
                    >
                      <svg className={`w-4 h-4 ${isSaving ? 'animate-bounce' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                      </svg>
                      {isSaving ? 'Saving...' : 'Save'}
                    </button>
                    <div className="w-px h-4 bg-slate-800" />
                    <button 
                      onClick={() => setTranscriptions([])}
                      className="text-xs font-bold text-slate-500 hover:text-red-400 transition-colors uppercase tracking-widest flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      Clear
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="flex-grow overflow-y-auto p-6 space-y-6 scroll-smooth scrollbar-hide">
              {transcriptions.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-600">
                  <div className="w-20 h-20 border-2 border-dashed border-slate-800 rounded-full flex items-center justify-center mb-6">
                    <svg className="w-10 h-10 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                    </svg>
                  </div>
                  <p className="text-sm font-medium tracking-wide">Press Start and speak naturally</p>
                  <p className="text-[10px] uppercase mt-2 opacity-50">Translation will appear here</p>
                </div>
              ) : (
                transcriptions.map((t, i) => (
                  <div key={i} className={`flex flex-col ${t.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-2`}>
                    <div className={`max-w-[85%] rounded-[1.5rem] px-5 py-4 ${
                      