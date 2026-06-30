'use client';

import { useEffect, useRef, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1';
const API_KEY = process.env.NEXT_PUBLIC_API_KEY ?? '';
// The bridge (apps/bridge) is a separate service; the CLIENT forwards JSON to it.
const BRIDGE_URL = process.env.NEXT_PUBLIC_BRIDGE_URL ?? 'http://localhost:8000';

interface Command {
  action: string;
  duration?: number;
}

export default function Home() {
  const [text, setText] = useState('cho xe chạy tới một đoạn rồi quẹo phải');
  const [transcript, setTranscript] = useState('');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false);

  // Robot bridge state.
  const [commands, setCommands] = useState<Command[]>([]);
  const [bridgeMsg, setBridgeMsg] = useState('');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Web Audio plumbing for the live visualizer.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  // Clean up any leftover audio graph / animation frame on unmount.
  useEffect(() => stopVisualizer, []);

  async function call(path: string, init: RequestInit) {
    setLoading(true);
    setResult('');
    setBridgeMsg('');
    setCommands([]);
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers: { 'X-API-Key': API_KEY, ...(init.headers ?? {}) },
      });
      const json = await res.json();
      setTranscript(typeof json.original_text === 'string' ? json.original_text : '');
      setResult(JSON.stringify(json, null, 2));

      const cmds: Command[] = Array.isArray(json.commands) ? json.commands : [];
      if (json.status === 'success' && cmds.length) {
        setCommands(cmds);
        await executeOnRobot(cmds); // voice → JSON → robot, always auto-run
      }
    } catch (err) {
      setResult(`Error: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  /** Forward validated commands to the bridge (fire-and-forget → 202). */
  async function executeOnRobot(cmds: Command[]) {
    setBridgeMsg('Đang gửi lệnh xuống robot…');
    try {
      const res = await fetch(`${BRIDGE_URL}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands: cmds }),
      });
      if (res.status === 409) {
        setBridgeMsg('⚠️ Robot đang bận chạy chuỗi trước — thử lại sau.');
        return;
      }
      const j = await res.json().catch(() => ({}));
      setBridgeMsg(`🤖 Robot đã nhận ${j.steps ?? cmds.length} bước (HTTP ${res.status}).`);
    } catch (err) {
      setBridgeMsg(`Không gọi được bridge (${BRIDGE_URL}). Bridge đã chạy chưa? — ${String(err)}`);
    }
  }

  function sendText() {
    setTranscript('');
    return call('/robot/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  }

  function sendAudio(blob: Blob) {
    const form = new FormData();
    form.append('file', blob, 'command.webm');
    return call('/robot/command/audio', { method: 'POST', body: form });
  }

  /** Draw mic input as animated bars so the user sees their voice is being captured. */
  function startVisualizer(stream: MediaStream) {
    const audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    audioCtxRef.current = audioCtx;
    analyserRef.current = analyser;

    const data = new Uint8Array(analyser.frequencyBinCount);

    const draw = () => {
      const canvas = canvasRef.current;
      const a = analyserRef.current;
      if (!canvas || !a) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      a.getByteFrequencyData(data);
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);

      const bars = 48;
      const step = Math.floor(data.length / bars);
      const gap = 2;
      const barWidth = width / bars - gap;
      for (let i = 0; i < bars; i++) {
        const v = data[i * step] / 255; // 0..1
        const barHeight = Math.max(2, v * height);
        ctx.fillStyle = `rgb(${80 + v * 175}, ${230 - v * 80}, ${130})`;
        ctx.fillRect(i * (barWidth + gap), (height - barHeight) / 2, barWidth, barHeight);
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
  }

  function stopVisualizer() {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    analyserRef.current = null;
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
    const canvas = canvasRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }

  async function toggleRecord() {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    setTranscript('');
    setResult('');
    // Better capture: mono + noise/echo handling reduces the silence that makes Whisper hallucinate.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      stopVisualizer();
      stream.getTracks().forEach((t) => t.stop());
      setRecording(false);
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      // Guard: a near-empty blob means no audio was captured — sending it just makes Whisper hallucinate.
      if (blob.size < 2000) {
        setResult(
          `Audio rỗng (${blob.size} bytes). Mic không thu được tiếng — kiểm tra quyền/thiết bị micro, ` +
            'và xem thanh sóng có nhảy khi nói không. Hãy nói rõ ~1–2 giây rồi mới bấm Dừng.',
        );
        return;
      }
      void sendAudio(blob);
    };
    recorderRef.current = recorder;
    recorder.start();
    setRecording(true);
    startVisualizer(stream);
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <header>
        <h1 className="text-2xl font-bold">Speech to Action</h1>
        <p className="text-sm text-slate-400">
          Client tối thiểu để kiểm tra API. Sản phẩm chính là API NestJS.
        </p>
      </header>

      <section className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900 p-5">
        <label className="text-sm font-medium text-slate-300">Gửi text</label>
        <textarea
          className="min-h-20 rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm outline-none focus:border-sky-500"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          onClick={sendText}
          disabled={loading}
          className="self-start rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold hover:bg-sky-500 disabled:opacity-50"
        >
          POST /robot/command
        </button>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900 p-5">
        <label className="text-sm font-medium text-slate-300">Ghi âm (gửi audio)</label>

        {/* Live waveform — only meaningful while recording */}
        <canvas
          ref={canvasRef}
          width={560}
          height={72}
          className={`w-full rounded-lg border border-slate-800 bg-slate-950 transition-opacity ${
            recording ? 'opacity-100' : 'opacity-40'
          }`}
        />
        {recording && (
          <p className="text-xs text-emerald-400">● Đang nghe… hãy nói lệnh của bạn</p>
        )}

        <button
          onClick={toggleRecord}
          disabled={loading}
          className={`self-start rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50 ${
            recording ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'
          }`}
        >
          {recording ? '⏹ Dừng & gửi' : '🎙️ Bắt đầu ghi'}
        </button>
      </section>

      {/* Transcribed sentence (original_text) shown right after speaking */}
      {(transcript || loading) && (
        <section className="flex flex-col gap-2 rounded-xl border border-sky-900 bg-sky-950/40 p-5">
          <span className="text-sm font-medium text-sky-300">Câu bạn vừa nói</span>
          <p className="text-lg text-slate-100">
            {transcript || <span className="text-slate-500">…</span>}
          </p>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <span className="text-sm font-medium text-slate-300">
          Kết quả {loading && <span className="text-slate-500">· đang xử lý…</span>}
        </span>
        <pre className="min-h-32 overflow-auto rounded-xl border border-slate-800 bg-black p-4 text-xs text-emerald-300">
          {result || '—'}
        </pre>
      </section>

      {/* Robot bridge — forward JSON to apps/bridge → physical movement */}
      <section className="flex flex-col gap-3 rounded-xl border border-amber-900 bg-amber-950/30 p-5">
        <label className="text-sm font-medium text-amber-300">Robot (qua bridge)</label>

        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => executeOnRobot(commands)}
            disabled={loading || commands.length === 0}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold hover:bg-amber-500 disabled:opacity-50"
          >
            ▶ Thực thi trên robot{commands.length ? ` (${commands.length} bước)` : ''}
          </button>
        </div>

        {bridgeMsg && <p className="text-sm text-amber-200">{bridgeMsg}</p>}
        <p className="text-xs text-slate-500">Bridge: {BRIDGE_URL}</p>
      </section>
    </main>
  );
}
