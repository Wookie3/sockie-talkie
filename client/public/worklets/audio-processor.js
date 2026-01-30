class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.port.onmessage = (event) => {
      if (event.data.type === 'setSampleRate') {
        this.sampleRate = event.data.sampleRate
      }
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    const output = outputs[0]
    
    if (input.length > 0 && input[0].length > 0) {
      const inputData = input[0]
      const outputData = output[0]
      
      // Copy input to output (don't transfer buffer)
      for (let channel = 0; channel < input.length; channel++) {
        outputData[channel].set(inputData[channel])
      }
      
      // Send audio data to main thread (create copy of buffer)
      const float32Array = new Float32Array(inputData[0])
      this.port.postMessage({
        type: 'audioData',
        buffer: float32Array.buffer
      }, [float32Array.buffer])
    }
    
    return true
  }
}

registerProcessor('audio-processor', AudioProcessor)