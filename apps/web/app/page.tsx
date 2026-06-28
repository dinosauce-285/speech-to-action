'use client';

import { useRef, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1';
const API_KEY = process.env.NEXT_PUBLIC_API_KEY ?? '';

export default function Home() {
  const [text, setText] = useState('cho xe chạy tới một đoạn rồi quẹo phải');
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function call(path: string, init: RequestInit) {
    setLoading(true);
    setResult('');
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers: { 'X-API-Key': API_KEY, ...(init.headers ?? {}) },
      });
      const json = await res.json();
      setResult(JSON.stringify(json, null, 2));
    } catch (err) {
      setResult(`Error: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  function sendText() {
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

  async function toggleRecord() {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      setRecording(false);
      void sendAudio(new Blob(chunksRef.current, { type: 'audio/webm' }));
    };
    recorderRef.current = recorder;
    recorder.start();
    setRecording(true);
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <header>
        <h1 className="text-2xl font-bold">Voice → JSON · Test Client</h1>
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

      <section className="flex flex-col gap-2">
        <span className="text-sm font-medium text-slate-300">
          Kết quả {loading && <span className="text-slate-500">· đang xử lý…</span>}
        </span>
        <pre className="min-h-32 overflow-auto rounded-xl border border-slate-800 bg-black p-4 text-xs text-emerald-300">
          {result || '—'}
        </pre>
      </section>
    </main>
  );
}
