/**
 * 录音并编码为 ASR 接受的 WAV（单声道、16-bit PCM）。
 *
 * AudioContext 请求 16kHz，浏览器负责重采样；ScriptProcessorNode 采集 PCM 样本。
 *
 * **注意**：`new AudioContext({ sampleRate })` 只是建议值，Android WebView 与部分
 * 浏览器会忽略它并按硬件原生采样率（常见 48kHz）运行。因此 WAV 头必须用
 * `context.sampleRate` 的真实值写入——写死 16000 会让 ASR 把 48k 音频当 16k 解码，
 * 声音变成 1/3 速度，识别结果为空或乱码。
 */
export const SAMPLE_RATE = 16000
/** ASR 单次时长上限 120 秒 */
export const MAX_SECONDS = 120

const BUFFER_SIZE = 4096

export type Recording = {
  /** 停止录音并返回 WAV；没有采到声音时返回 null */
  stop: () => Promise<Blob | null>
  /** 放弃录音，释放麦克风 */
  cancel: () => void
  /** 频谱分析节点，只读；采样率与录音一致 */
  analyser: AnalyserNode
}

/** 开始录音；到达时长上限时调用 onLimit，由调用方决定何时 stop */
export const startRecording = async (onLimit: () => void): Promise<Recording> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  })
  let context: AudioContext | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let processor: ScriptProcessorNode | undefined
  let analyser: AnalyserNode | undefined
  let released = false

  const release = () => {
    if (released) {
      return
    }
    released = true
    if (processor) {
      processor.onaudioprocess = null
    }
    // 初始化可能只完成了一部分；单个节点断开失败也不能阻止麦克风释放。
    for (const node of [processor, analyser, source]) {
      try {
        node?.disconnect()
      } catch {
        // 继续释放其余资源。
      }
    }
    for (const track of stream.getTracks()) {
      track.stop()
    }
    void context?.close().catch(() => {})
  }

  try {
    context = new AudioContext({ sampleRate: SAMPLE_RATE })
    source = context.createMediaStreamSource(stream)
    processor = context.createScriptProcessor(BUFFER_SIZE, 1, 1)
    // 实际采样率可能与请求的不同，后面编码 WAV 头要用它
    const actualRate = context.sampleRate
    // 频谱分析用：串在录音链路中间（原样透传），WebKit 不会处理未连到输出的分析节点
    analyser = context.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.2
    const chunks: Float32Array[] = []
    let length = 0
    let limited = false
    processor.onaudioprocess = (event) => {
      if (limited) {
        return
      }
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      length += BUFFER_SIZE
      if (length >= MAX_SECONDS * actualRate) {
        limited = true
        onLimit()
      }
    }
    source.connect(analyser)
    analyser.connect(processor)
    // ScriptProcessorNode 只有连到输出才会持续回调；输出缓冲保持静音
    processor.connect(context.destination)
    // 在 await getUserMedia 之后创建，iOS 上可能处于 suspended
    if (context.state === 'suspended') {
      void context.resume().catch(() => {})
    }

    return {
      stop: async () => {
        release()
        return length === 0 ? null : encodeWav(chunks, length, actualRate)
      },
      cancel: release,
      analyser,
    }
  } catch (error) {
    release()
    throw error
  }
}

const encodeWav = (chunks: Float32Array[], length: number, sampleRate: number) => {
  const samples = Math.min(length, MAX_SECONDS * sampleRate)
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i))
    }
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  // 用真实采样率，不能写死 16000：浏览器可能忽略了创建时的请求
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, samples * 2, true)
  let offset = 44
  let written = 0
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length && written < samples; i++, written++) {
      const sample = Math.max(-1, Math.min(1, chunk[i]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
