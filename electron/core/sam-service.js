'use strict';

const sharp = require('sharp');
const ort = require('onnxruntime-node');

const MODEL_LONG_SIDE = 1024;
const LOW_RES_SIZE = 256;

function validateSize(size) {
  const width = Number(size?.width);
  const height = Number(size?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('无效的 SAM 图像尺寸');
  }
  return { width, height };
}

function fitImageToModel(sourceSize, longSide = MODEL_LONG_SIDE) {
  const { width, height } = validateSize(sourceSize);
  const scale = longSide / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

function decoderPrompts(points, fit) {
  if (!Array.isArray(points) || !points.length) throw new Error('请至少添加一个 SAM 目标点');
  const coords = new Float32Array(points.length * 2);
  const labels = new Float32Array(points.length);
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    coords[index * 2] = Number(point.x) * fit.scale;
    coords[index * 2 + 1] = Number(point.y) * fit.scale;
    labels[index] = point.positive === false ? 0 : 1;
  }
  return { coords, labels };
}

function restoreMask(modelMask, modelSize, sourceSize) {
  const model = validateSize(modelSize);
  const source = validateSize(sourceSize);
  const result = new Uint8Array(source.width * source.height);
  for (let y = 0; y < source.height; y += 1) {
    const modelY = Math.min(model.height - 1, Math.floor(y * model.height / source.height));
    for (let x = 0; x < source.width; x += 1) {
      const modelX = Math.min(model.width - 1, Math.floor(x * model.width / source.width));
      result[y * source.width + x] = modelMask[modelY * model.width + modelX] > 0 ? 1 : 0;
    }
  }
  return result;
}

class SamService {
  constructor(modelPaths) {
    this.modelPaths = modelPaths;
    this.encoder = null;
    this.decoder = null;
    this.prepared = null;
  }

  async loadSessions() {
    if (!this.encoder) {
      this.encoder = await ort.InferenceSession.create(
        this.modelPaths.encoder,
        { executionProviders: ['cpu'], graphOptimizationLevel: 'all' },
      );
    }
    if (!this.decoder) {
      this.decoder = await ort.InferenceSession.create(
        this.modelPaths.decoder,
        { executionProviders: ['cpu'], graphOptimizationLevel: 'all' },
      );
    }
  }

  async prepareImage(imagePath) {
    if (!imagePath) throw new Error('SAM 图像路径不能为空');
    if (this.prepared?.imagePath === imagePath) return this.prepared.summary;
    await this.loadSessions();
    const metadata = await sharp(imagePath).metadata();
    const sourceSize = validateSize(metadata);
    const fit = fitImageToModel(sourceSize);
    const rgb = await sharp(imagePath)
      .flatten({ background: { r: 0, g: 0, b: 0 } })
      .resize(fit.width, fit.height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .removeAlpha()
      .raw()
      .toBuffer();
    const input = new Float32Array(rgb.length);
    for (let index = 0; index < rgb.length; index += 1) input[index] = rgb[index];
    const result = await this.encoder.run({
      input_image: new ort.Tensor('float32', input, [fit.height, fit.width, 3]),
    });
    const summary = { imagePath, sourceSize, modelSize: { width: fit.width, height: fit.height } };
    this.prepared = { imagePath, sourceSize, fit, embedding: result.image_embeddings, summary };
    return summary;
  }

  async predict({ imagePath, points }) {
    await this.prepareImage(imagePath);
    const { fit, sourceSize, embedding } = this.prepared;
    const prompts = decoderPrompts(points, fit);
    const result = await this.decoder.run({
      image_embeddings: embedding,
      point_coords: new ort.Tensor('float32', prompts.coords, [1, points.length, 2]),
      point_labels: new ort.Tensor('float32', prompts.labels, [1, points.length]),
      mask_input: new ort.Tensor('float32', new Float32Array(LOW_RES_SIZE * LOW_RES_SIZE), [1, 1, LOW_RES_SIZE, LOW_RES_SIZE]),
      has_mask_input: new ort.Tensor('float32', Float32Array.of(0), [1]),
      orig_im_size: new ort.Tensor('float32', Float32Array.of(fit.height, fit.width), [2]),
    });
    const maskTensor = result.masks;
    const height = maskTensor.dims[maskTensor.dims.length - 2];
    const width = maskTensor.dims[maskTensor.dims.length - 1];
    const mask = restoreMask(maskTensor.data, { width, height }, sourceSize);
    return {
      mask,
      width: sourceSize.width,
      height: sourceSize.height,
      score: Number(result.iou_predictions?.data?.[0] ?? 0),
    };
  }
}

module.exports = { SamService, decoderPrompts, fitImageToModel, restoreMask };
