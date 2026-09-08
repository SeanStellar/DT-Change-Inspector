(function exposeAnnotationCoordinates(root) {
  'use strict';

  function canvasPointToImage(transform, point, clampToEdge = false) {
  if (!transform) return null;

  const clipRight = transform.clip.x + transform.clip.width;
  const clipBottom = transform.clip.y + transform.clip.height;
  if (point.x < transform.clip.x || point.x > clipRight
    || point.y < transform.clip.y || point.y > clipBottom) return null;

  const imageRight = transform.left + transform.displayWidth;
  const imageBottom = transform.top + transform.displayHeight;
  if (!clampToEdge && (point.x < transform.left || point.x > imageRight
    || point.y < transform.top || point.y > imageBottom)) return null;

  const canvasX = Math.max(transform.left, Math.min(imageRight, point.x));
  const canvasY = Math.max(transform.top, Math.min(imageBottom, point.y));
  return {
    x: Math.max(0, Math.min(transform.sourceWidth - 1,
      Math.round((canvasX - transform.left) * transform.sourceWidth / transform.displayWidth))),
    y: Math.max(0, Math.min(transform.sourceHeight - 1,
      Math.round((canvasY - transform.top) * transform.sourceHeight / transform.displayHeight))),
  };
  }

  if (root) root.annotationCoordinates = { canvasPointToImage };
  if (typeof module !== 'undefined' && module.exports) module.exports = { canvasPointToImage };
}(typeof window !== 'undefined' ? window : null));
