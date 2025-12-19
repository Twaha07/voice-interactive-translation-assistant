
import React, { useEffect, useRef } from 'react';

interface VoiceVisualizerProps {
  isActive: boolean;
  isModelSpeaking: boolean;
}

export const VoiceVisualizer: React.FC<VoiceVisualizerProps> = ({ isActive, isModelSpeaking }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!isActive) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    let offset = 0;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const time = Date.now() * 0.005;
      const centerY = canvas.height / 2;
      const width = canvas.width;
      
      ctx.beginPath();
      ctx.lineWidth = 3;
      
      if (isModelSpeaking) {
        ctx.strokeStyle = '#38bdf8'; // Blue for model
      } else {
        ctx.strokeStyle = '#818cf8'; // Indigo for user
      }

      for (let x = 0; x < width; x++) {
        const amplitude = isModelSpeaking ? 30 : 15;
        const frequency = isModelSpeaking ? 0.02 : 0.01;
        const y = centerY + Math.sin(x * frequency + time) * amplitude * Math.sin(time * 0.5);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      
      ctx.stroke();
      animationId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationId);
  }, [isActive, isModelSpeaking]);

  return (
    <div className={`relative w-full h-32 flex items-center justify-center rounded-2xl overflow-hidden bg-slate-800/50 border border-slate-700 transition-all duration-500 ${isActive ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}`}>
      <canvas ref={canvasRef} width={600} height={128} className="w-full h-full" />
      <div className="absolute inset-0 bg-gradient-to-r from-slate-900/40 via-transparent to-slate-900/40 pointer-events-none" />
    </div>
  );
};
