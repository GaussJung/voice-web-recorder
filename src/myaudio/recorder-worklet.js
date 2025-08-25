// recorder-worklet.js
class RecorderWorkletProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      const channelData = input[0]; // Float32Array
      const chunk = new Float32Array(channelData.length);
      chunk.set(channelData);
      this.port.postMessage(chunk, [chunk.buffer]);
    }
    return true;
  }
}
registerProcessor('recorder-worklet', RecorderWorkletProcessor);
