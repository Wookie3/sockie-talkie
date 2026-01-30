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
      
      // Copy input to output
      for (let channel = 0; channel < input.length; channel++) {
        for (let i = 0; i < inputData[channel].length; i++) {
          outputData[channel][i] = inputData[channel][i]
        }
      }
      
      // Send audio data to main thread
      this.port.postMessage({
        type: 'audioData',
        buffer: inputData[0].buffer
      }, [inputData[0].buffer])
    }
    
    return true
  }
}

registerProcessor('audio-processor', AudioProcessor)