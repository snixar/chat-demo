import { CSSProperties, ReactNode, memo, useState } from 'react'

/**
 * 带加载兜底的图片：loading 骨架占位 → 成功显示 → 失败展示 fallback 内容。
 * 只提供三态行为，视觉全部由调用方类名决定。
 *
 * 图片来源是第三方站点（搜索结果图标），因此不带 Referer 且延迟加载：
 * 请求本身仍会暴露用户 IP，这一点无法在前端消除，只能靠代理。
 */
export const FallbackImage = memo(function FallbackImage({
  src,
  fallback,
  className,
  imgClassName,
  skeletonClassName,
  fallbackClassName,
  style,
}: {
  src: string
  /** 加载失败（或 src 为空）时展示的兜底内容 */
  fallback: ReactNode
  /** 容器类名，尺寸 / 圆角 / 背景由调用方定义 */
  className: string
  imgClassName: string
  /** loading 骨架占位层类名 */
  skeletonClassName: string
  /** 兜底内容包裹层类名 */
  fallbackClassName: string
  style: CSSProperties | undefined
}) {
  const [loadResult, setLoadResult] = useState<'loading' | 'error' | 'loaded'>(
    src ? 'loading' : 'error'
  )

  return (
    <div className={className} style={style}>
      {loadResult !== 'error' ? (
        <img
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
          onLoad={() => setLoadResult('loaded')}
          onError={() => setLoadResult('error')}
          style={{ display: loadResult === 'loaded' ? 'block' : 'none' }}
          className={imgClassName}
        />
      ) : null}
      {loadResult === 'error' ? <div className={fallbackClassName}>{fallback}</div> : null}
      {loadResult === 'loading' ? <div className={skeletonClassName} /> : null}
    </div>
  )
})
