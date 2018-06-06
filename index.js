const path = require('path');
const Emittery = require('emittery');
const envPaths = require('env-paths');
const getStream = require('get-stream');
const got = require('got');
const isStream = require('is-stream');
const isUrl = require('is-url-superb');
const Jimp = require('jimp');
const mkdirp = require('mkdirp');
const pify = require('pify');
const screenshot = require('screenshot-stream');
const typeis = require('type-is');
const uniq = require('lodash/uniq');
const frameData = require('./data/frames.json');

const paths = envPaths('deviceframe');
const frameCacheDir = path.join(paths.cache, 'frames');
const webCacheDir = path.join(paths.cache, 'web');

// ------------
init();
// ------------

function init() {
  // Add shadow suffix on to frame name
  frameData.forEach(frame => {
    if (frame.shadow) frame.name = `${frame.name} [shadow]`;
  });

  makeCacheDirs();
}

function makeCacheDirs() {
  mkdirp(webCacheDir, err => {
    if (err) throw err;
  });

  mkdirp(frameCacheDir, err => {
    if (err) throw err;
  });
}

async function devices() {
  return Promise.resolve(uniq(frameData.map(x => x.device)).sort());
}

async function downloadFrames(...frames) {
  return frames.download(frames, frameCacheDir);
}

async function frames() {
  return Promise.resolve(frameData);
}

async function webshot(url, frameConf, opts) {
  const response = await got(url, { encoding: null });

  if (typeis(response, ['image/*'])) return response.body;

  // Scale image size for device pixel density
  const w = Math.floor(frameConf.frame.width / (frameConf.pixelRatio || 1));
  const h = Math.floor(frameConf.frame.height / (frameConf.pixelRatio || 1));
  const dim = [w, h].join('x');

  // const spinner = ora(`Screenshotting ${imgUrl} at ${dim}`).start();
  // ee.emit('log', `Screenshotting ${url} at ${dim}`);

  // TODO: need to dynamically choose device user-agent from a list, or store them with the frames
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1';
  const stream = screenshot(url, dim, { crop: false, userAgent: ua, delay: opts.delay })
  .on('error', err => {
    // ee.emit('error', err);
    throw err;
  })
  .on('end', () => {
    // TODO: some event here so a spinner could be used
    // spinner.succeed()
  });

  const buf = await getStream.buffer(stream);

  // .then(([buf, w, h]) => new Promise((resolve, reject) => {
  const lenna = await Jimp.read(buf);

  const result = await pify(
    lenna.resize(w, Jimp.AUTO)
      .crop(0, 0, w, h)
      .getBuffer
  )(Jimp.MIME_PNG);

  return result;
}

function resize(frame, jimg, frameConf) {
  const frameImageWidth = frame.bitmap.width;
  const frameImageHeight = frame.bitmap.height;

  const compLeftRatio = frameConf.frame.left / frameImageWidth;
  const compTopRatio = frameConf.frame.top / frameImageHeight;

  let compLeft = frameConf.frame.left;
  let compTop = frameConf.frame.top;

  const frameMax = Math.max(frameConf.frame.height, frameConf.frame.width);
  const jimgMax = Math.max(jimg.bitmap.height, jimg.bitmap.width);

  // Frame is bigger, size it down to source image
  if (frameMax > jimgMax) {
    // Resize frame so shortest dimension matches source image. Source image overflow will be clipped
    let rH = frame.bitmap.height;
    let rW = frame.bitmap.width;
    if (frameConf.frame.height > frameConf.frame.width) {
      const ratio = jimg.bitmap.width / frameConf.frame.width;
      rW = Math.ceil(rW * ratio);
      rH = Jimp.AUTO;
    } else {
      const ratio = jimg.bitmap.height / frameConf.frame.height;
      rH = Math.ceil(rH * ratio);
      rW = Jimp.AUTO;
    }

    frame.resize(rW, rH);

    // We resized the frame so there's a new compositing location on it
    compLeft = Math.ceil(frame.bitmap.width * compLeftRatio);
    compTop = Math.ceil(frame.bitmap.height * compTopRatio);

    // Resize source image to fit new frame size
    const newFrameWidth = frameConf.frame.width * (frame.bitmap.width / frameImageWidth);
    const newFrameHeight = frameConf.frame.height * (frame.bitmap.height / frameImageHeight);

    jimg.cover(newFrameWidth, newFrameHeight);
  } else {
    // Source image is bigger, size it down to frame
    // Resize frame so shortest dimension matches
    let rH = jimg.bitmap.height;
    let rW = jimg.bitmap.width;
    if (rH > rW) {
      rW = frameConf.frame.width;
      rH = Jimp.AUTO;
    } else {
      rH = frameConf.frame.height;
      rW = Jimp.AUTO;
    }

    jimg.cover(frameConf.frame.width, frameConf.frame.height);
  }

  return [frame, jimg, { left: compLeft, top: compTop }, frameConf];
}

async function frame(img, frameConf) {
  return new Promise((resolve, reject) => {
    this.stream(img, frameConf)
    .on('error', err => reject(err))
    .on('end', buffer => resolve(buffer));
  });
}

// Image can be a file or url
function stream(img, frameConf, opts = { delay: 0 }) {
  const ee = new Emittery();
  ee.emit('debug', 'Framing images');

  if (isStream(img)) {
    img = getStream.buffer(img);
  } else if (isUrl(img)) {
    const imgUrl = img;
    // debug(`Checking for image: ${imgUrl}`);
    img = webshot(imgUrl, frameConf, opts);
  }

  // Read in image and frame
  Promise.resolve(img)
  .then(imgData => {
    const framePath = path.join(frameCacheDir, frameConf.relPath);

    ee.emit('debug', `Reading in frame from ${framePath}`);

    return Promise.all([
      Jimp.read(framePath),
      Jimp.read(imgData),
    ]);
  })
  // Resize largest image to fit the other
  .then(([frame, jimg]) => {
    ee.emit('debug', 'Resizing frame/image');

    return resize(frame, jimg, frameConf);
  })
  .then(([frame, jimg, compPos, frameConf]) => {
    ee.emit('debug', `Compositing... ${frameConf.frame.left} ${frameConf.frame.top}`);

    // Create a canvas the same as the frame size for the screenshot to be placed on at the frame top/left coordinates
    const canvas = new Jimp(frame.bitmap.width, frame.bitmap.height);
    jimg = canvas.composite(jimg, compPos.left, compPos.top);

    return jimg.composite(frame, 0, 0);
  })
  .then(composite => {
    // composite.write(imgPath);
    // console.log(chalk.bold('> ') + chalk.green('Wrote: ') + imgPath);

    return new Promise((resolve, reject) => {
      composite.getBuffer(Jimp.MIME_PING, (err, buffer) => {
        if (err) return reject(err);

        resolve(buffer);
        ee.emit('end', buffer);
      });
    });
  });

  return ee;
}

module.exports = {
  devices,
  downloadFrames,
  frame,
  frames,
  stream,
};
