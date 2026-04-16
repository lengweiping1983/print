type MaskRequest = {
  id: number;
  bitmap: ImageBitmap;
};

type MaskResponse =
  | {
      id: number;
      width: number;
      height: number;
      buffer: ArrayBuffer;
    }
  | {
      id: number;
      error: string;
    };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<MaskRequest>) => void) | null;
  postMessage: (message: MaskResponse, transfer?: Transferable[]) => void;
};

workerScope.onmessage = (event: MessageEvent<MaskRequest>) => {
  const { id, bitmap } = event.data;
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建 mask 处理画布。");

    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const { data } = imageData;
    for (let index = 0; index < data.length; index += 4) {
      const sourceAlpha = data[index + 3];
      const luminanceAlpha = Math.max(data[index], data[index + 1], data[index + 2]);
      const alpha = sourceAlpha < 255 ? sourceAlpha : luminanceAlpha;
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = alpha;
    }

    const response: MaskResponse = {
      id,
      width: canvas.width,
      height: canvas.height,
      buffer: imageData.data.buffer as ArrayBuffer
    };
    workerScope.postMessage(response, [imageData.data.buffer as ArrayBuffer]);
  } catch (error) {
    const response: MaskResponse = {
      id,
      error: error instanceof Error ? error.message : "mask 处理失败。"
    };
    workerScope.postMessage(response);
  }
};

export {};
