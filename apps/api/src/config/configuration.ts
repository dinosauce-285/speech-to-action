export interface AppConfig {
  port: number;
  apiKey: string;
  groq: {
    apiKey: string;
    sttModel: string;
    llmModel: string;
  };
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '3001', 10),
  apiKey: process.env.API_KEY ?? '',
  groq: {
    apiKey: process.env.GROQ_API_KEY ?? '',
    sttModel: process.env.GROQ_STT_MODEL ?? 'whisper-large-v3',
    llmModel: process.env.GROQ_LLM_MODEL ?? 'llama-3.3-70b-versatile',
  },
});
