'use client';

import { useEffect, useMemo, useState } from 'react';
import styles from './page.module.css';

const STORAGE_KEY = 'nano_banana_access_token';

interface GalleryItem {
  filename: string;
  localUrl: string;
  remoteUrl: string;
}

interface Config {
  success?: boolean;
  defaultModelName?: string;
  hasEnvAccessToken?: boolean;
  hasRuntimeAccessToken?: boolean;
  tokenSource?: string;
  activeServerToken?: boolean;
  envNames?: string[];
  runtimeEnvFile?: string;
}

async function fetchJson(url: string, options?: RequestInit) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok || data.success === false) {
    const error = new Error(data.error || data.errMessage || '请求失败');
    (error as any).tokenExpired = Boolean(data.tokenExpired);
    (error as any).errCode = data.errCode || null;
    throw error;
  }
  return data;
}

export default function TokenPage() {
  const [composerOpen, setComposerOpen] = useState(false);
  const [healthText, setHealthText] = useState('等待检测...');
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [accessToken, setAccessToken] = useState('');
  const [contact, setContact] = useState('');
  const [code, setCode] = useState('');
  const [prompt, setPrompt] = useState('');
  const [modelName, setModelName] = useState('gemini-3-pro-image-preview');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [numImages, setNumImages] = useState('1');
  const [size, setSize] = useState('2K');
  const [outputFormat, setOutputFormat] = useState('png');
  const [imageUrls, setImageUrls] = useState('');
  const [identities, setIdentities] = useState<any[]>([]);
  const [selectedIdentity, setSelectedIdentity] = useState('');
  const [identityWrapVisible, setIdentityWrapVisible] = useState(false);
  const [generationStatus, setGenerationStatus] = useState('未开始');
  const [authStatusText, setAuthStatusText] = useState('等待检测认证状态...');
  const [tokenModeText, setTokenModeText] = useState('等待检测服务端 token...');
  const [tokenHelpText, setTokenHelpText] = useState('你忘记 ACCESS_TOKEN 也没关系，可以直接重新登录获取。');
  const [loadingSendCode, setLoadingSendCode] = useState(false);
  const [loadingLogin, setLoadingLogin] = useState(false);
  const [loadingGenerate, setLoadingGenerate] = useState(false);

  const localToken = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) || '' : '';

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(STORAGE_KEY) || '';
    if (stored) setAccessToken(stored);
    // initialize gallery from localStorage if any
    loadConfig().then(() => checkAuthStatus());
    checkHealth();
  }, []);

  useEffect(() => {
    refreshTokenUi();
  }, [config, accessToken]);

  async function loadConfig() {
    try {
      const data = await fetchJson('/api/config');
      setConfig(data);
      if (data.defaultModelName) setModelName(data.defaultModelName);
    } catch (err: any) {
      setTokenModeText(`配置读取失败：${err.message}`);
    }
  }

  function refreshTokenUi() {
    const hasLocal = Boolean(accessToken || localToken);
    if (!accessToken && localToken) {
      setAccessToken(localToken);
    }

    if (hasLocal) {
      setTokenModeText('已检测到页面本地 token。登录成功后会自动同步到服务端运行环境，当前项目和其它页面都能直接调用。');
      setTokenHelpText('场景 1/3：没有 token 或 token 过期时，在 /token 重新登录即可，服务端会自动更新 .env.runtime。');
      return;
    }

    if (config?.tokenSource === 'runtime_file' || config?.hasRuntimeAccessToken) {
      setTokenModeText('服务端已加载通过 /token 页面保存的 token，当前项目和其它页面都可直接调用。');
      setTokenHelpText('这个 token 已写入项目内 .env.runtime，并在当前服务端进程中生效。');
      return;
    }

    if (config?.hasEnvAccessToken) {
      setTokenModeText('服务端已配置启动环境变量 token，代码会自动直接调用模型。');
      setTokenHelpText('场景 2：启动前设置 NEODOMAIN_ACCESS_TOKEN 或 ACCESS_TOKEN 即可，无需在页面重复输入。');
      return;
    }

    setTokenModeText('当前没有可用 token。请在 /token 登录获取，登录成功后会自动写入服务端运行环境。');
    setTokenHelpText('场景 1：初次没有 ACCESS_TOKEN 时，验证码登录后即可直接生成。');
  }

  async function checkHealth() {
    try {
      const data = await fetchJson('/api/health');
      setHealthText(`服务正常，超时 ${data.timeoutSeconds} 秒，默认模型 ${data.defaultModelName}，token 来源 ${data.activeTokenSource}`);
    } catch (err: any) {
      setHealthText(err.message);
    }
  }

  async function checkAuthStatus() {
    try {
      const token = accessToken || localToken;
      const data = await fetchJson('/api/auth/status', {
        headers: token ? { 'x-access-token': token } : {},
      });
      setAuthStatusText(data.message);
    } catch (err: any) {
      setAuthStatusText(`认证状态检查失败：${err.message}`);
    }
  }

  async function syncTokenToServer(token: string) {
    if (!token) return;
    await fetchJson('/api/token/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: token }),
    });
  }

  async function clearStoredToken() {
    setAccessToken('');
    if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY);
    try {
      await fetchJson('/api/token/clear', { method: 'POST' });
    } catch (e: any) {
      console.warn(e.message);
    }
    refreshTokenUi();
    checkAuthStatus();
  }

  async function applyFreshToken(token: string, successText: string) {
    setAccessToken(token);
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, token);
    await syncTokenToServer(token);
    await loadConfig();
    refreshTokenUi();
    checkAuthStatus();
    alert(successText);
  }

  async function sendCode() {
    if (!contact.trim()) return alert('请先输入手机号或邮箱');
    setLoadingSendCode(true);
    try {
      await fetchJson('/api/login/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact: contact.trim() }),
      });
      alert('验证码已发送');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoadingSendCode(false);
    }
  }

  async function login() {
    if (!contact.trim() || !code.trim()) return alert('请输入手机号/邮箱 和 验证码');
    setLoadingLogin(true);
    try {
      const result = await fetchJson('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact: contact.trim(), code: code.trim(), invitationCode: '' }),
      });
      const data = result.data || {};
      if (data.needSelectIdentity) {
        const list = data.identities || [];
        setIdentities(list);
        setSelectedIdentity(list[0]?.userId || '');
        setIdentityWrapVisible(true);
        alert('检测到多身份，请先选择身份');
        return;
      }
      if (data.authorization) {
        await applyFreshToken(data.authorization, '已获取新 accessToken，并自动写入服务端运行环境。当前项目和其它页面都能直接调用。');
      } else {
        alert('登录成功，但未返回 authorization');
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoadingLogin(false);
    }
  }

  async function selectIdentity() {
    if (!contact.trim() || !selectedIdentity) return alert('请选择身份');
    setLoadingLogin(true);
    try {
      const result = await fetchJson('/api/login/select-identity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact: contact.trim(), userId: selectedIdentity }),
      });
      const data = result.data || {};
      if (data.authorization) {
        setIdentityWrapVisible(false);
        await applyFreshToken(data.authorization, '身份确认完成，新的 accessToken 已自动写入服务端运行环境。');
      } else {
        alert('身份确认成功，但未返回 authorization');
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoadingLogin(false);
    }
  }

  async function pollImageResultFrontend(taskCode: string) {
    const localTok = accessToken || localToken;
    const outFmt = outputFormat;
    for (let i = 0; i < 200; i += 1) {
      setGenerationStatus(`生成中... (${i + 1}/200)`);
      await new Promise((r) => setTimeout(r, 3000));
      const data = await fetchJson(`/api/result/${encodeURIComponent(taskCode)}`, {
        headers: localTok ? { 'x-access-token': localTok } : {},
      });
      const resultData = data.data || {};
      if (resultData.status === 'SUCCESS') {
        const urls: string[] = Array.isArray(resultData.image_urls) ? resultData.image_urls : [];
        const ext = outFmt === 'jpg' ? 'jpeg' : (outFmt || 'png');
        const savedImages: GalleryItem[] = urls.map((url: string, idx: number) => ({
          filename: `${taskCode}_${idx + 1}.${ext === 'jpeg' ? 'jpg' : ext}`,
          localUrl: url,
          remoteUrl: url,
        }));
        setGallery((prev) => [...savedImages, ...prev]);
        setGenerationStatus(`生成成功：${taskCode}`);
        return;
      }
      if (resultData.status === 'FAILED') {
        throw new Error(resultData.failure_reason || resultData.errorMessage || '图片生成失败');
      }
    }
    throw new Error('轮询结果超时，请稍后到图库查看');
  }

  async function generateImage() {
    const pr = prompt.trim();
    if (!pr) return alert('请输入提示词');
    const localTok = accessToken || localToken;
    if (localTok) {
      try {
        await syncTokenToServer(localTok);
      } catch (err: any) {
        alert(`服务端保存 token 失败：${err.message}`);
        return;
      }
    }
    if (!localTok && !config?.activeServerToken && !config?.hasEnvAccessToken && !config?.hasRuntimeAccessToken) {
      alert('当前没有可用的 accessToken。请先去 /token 登录获取，登录成功后代码会自动调用模型。');
      return;
    }
    setGenerationStatus('图像生成中，最长可能等待 10 分钟...');
    setLoadingGenerate(true);
    try {
      const result = await fetchJson('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: localTok,
          prompt: pr,
          syncMode: false,
          modelName: modelName.trim() || 'gemini-3-pro-image-preview',
          aspectRatio,
          numImages,
          size,
          outputFormat,
          imageUrls: imageUrls.split('\n').map((x) => x.trim()).filter(Boolean),
        }),
      });
      if (result.status === 'PENDING' && result.taskCode) {
        await pollImageResultFrontend(result.taskCode);
      } else {
        setGallery((prev) => [...(result.savedImages || []), ...prev]);
        setGenerationStatus(`生成成功：${result.taskCode}`);
      }
    } catch (error: any) {
      if (error.tokenExpired) {
        await clearStoredToken();
        setGenerationStatus('token 已过期，请重新登录获取新的 accessToken。');
        alert('当前 ACCESS_TOKEN 已过期或被撤销。请在 /token 重新获取，成功后会自动覆盖服务端运行环境。');
      } else {
        setGenerationStatus(`生成失败：${error.message}`);
        alert(error.message);
      }
    } finally {
      setLoadingGenerate(false);
    }
  }

  const heroPreviewContent = useMemo(() => {
    if (gallery.length > 0) {
      return <img src={gallery[0].remoteUrl || gallery[0].localUrl} alt="generated image" />;
    }
    return <div className={styles.previewPlaceholder}>点击开始生成</div>;
  }, [gallery]);

  return (
    <div className={styles.page}>
      <div className={styles.appShell}>
        <aside className={styles.leftBar}>
          <div className={styles.logoDot}></div>
          <div className={styles.leftLabel}>AI</div>
        </aside>

        <main className={styles.mainStage}>
          <section className={styles.heroCard} onClick={() => setComposerOpen(true)}>
            <div className={styles.heroToolbar}>
              <span className={`${styles.pill} ${styles.pillActive}`}>Image</span>
              <span className={styles.pill}>Nano Banana Pro</span>
              <span className={styles.pill}>/token</span>
            </div>
            <div className={styles.heroContent}>
              <div className={styles.heroText}>
                <h1>点击图片区域，弹出输入框并调用 Nano Banana Pro</h1>
                <p>默认模型：gemini-3-pro-image-preview</p>
              </div>
              <div className={styles.heroPreview}>{heroPreviewContent}</div>
            </div>
          </section>

          <section className={styles.statusCard}>
            <div>
              <div className={styles.statusTitle}>连接状态</div>
              <div className={styles.statusSubtitle}>{healthText}</div>
            </div>
            <button className={styles.secondaryBtn} onClick={checkHealth}>检查服务</button>
          </section>

          <section className={styles.galleryCard}>
            <div className={styles.cardHead}>
              <h2>当前项目输出</h2>
              <span>{gallery.length} 张</span>
            </div>
            <div className={styles.galleryGrid}>
              {gallery.length === 0 ? (
                <div className={styles.previewPlaceholder}>还没有生成图片</div>
              ) : (
                gallery.map((item, idx) => (
                  <div key={idx} className={styles.galleryItem}>
                    <img src={item.remoteUrl || item.localUrl} alt={item.filename} />
                    <div className={styles.galleryMeta}>{item.filename}</div>
                  </div>
                ))
              )}
            </div>
          </section>
        </main>
      </div>

      <div className={`${styles.composerSheet} ${composerOpen ? '' : styles.composerSheetHidden}`}>
        <div className={styles.sheetMask} onClick={() => setComposerOpen(false)} />
        <div className={styles.sheetPanel}>
          <div className={styles.sheetTopbar}>
            <div>
              <h3>图像生成</h3>
              <p>保持你截图里的暗色输入弹层风格</p>
            </div>
            <button className={styles.iconBtn} onClick={() => setComposerOpen(false)}>
              ×
            </button>
          </div>

          <div className={styles.panelGrid}>
            <section className={styles.panelBox}>
              <div className={styles.cardHead}>
                <h4>登录 / Access Token</h4>
              </div>
              <div className={`${styles.formRow} ${styles.twoCols}`}>
                <input
                  className={styles.input}
                  placeholder="手机号或邮箱"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                />
                <button className={styles.secondaryBtn} onClick={sendCode} disabled={loadingSendCode}>
                  发送验证码
                </button>
              </div>
              <div className={`${styles.formRow} ${styles.twoCols}`}>
                <input
                  className={styles.input}
                  placeholder="验证码"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <button className={styles.secondaryBtn} onClick={login} disabled={loadingLogin}>
                  登录获取 Token
                </button>
              </div>
              <div className={styles.formRow}>
                <textarea
                  className={styles.textarea}
                  placeholder="可直接粘贴 accessToken。登录成功后会自动保存在当前浏览器；若服务端已配置环境变量，也可以留空。"
                  value={accessToken}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAccessToken(v);
                    if (typeof window !== 'undefined') {
                      if (v) window.localStorage.setItem(STORAGE_KEY, v);
                      else window.localStorage.removeItem(STORAGE_KEY);
                    }
                    refreshTokenUi();
                  }}
                />
              </div>
              <div className={styles.tinyRow} style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <span>{tokenModeText}</span>
                <button className={styles.secondaryBtn} type="button" onClick={clearStoredToken}>
                  清除本地 Token
                </button>
              </div>
              <div className={styles.tinyRow}>
                <span>{tokenHelpText}</span>
              </div>
              <div className={styles.tinyRow}>
                <span>{authStatusText}</span>
              </div>
              <div className={`${styles.formRow} ${identityWrapVisible ? '' : styles.hidden}`}>
                <label className={styles.fieldLabel}>多身份选择</label>
                <select
                  className={styles.select}
                  value={selectedIdentity}
                  onChange={(e) => setSelectedIdentity(e.target.value)}
                >
                  {identities.map((item) => (
                    <option key={item.userId} value={item.userId}>
                      {item.nickname || '未命名'} / {item.enterpriseName || item.userType || ''}
                    </option>
                  ))}
                </select>
                <button className={styles.secondaryBtn} onClick={selectIdentity} disabled={loadingLogin}>
                  确认身份
                </button>
              </div>
            </section>

            <section className={styles.panelBox}>
              <div className={styles.cardHead}>
                <h4>生成参数</h4>
              </div>
              <div className={`${styles.formRow} ${styles.twoCols}`}>
                <div>
                  <label className={styles.fieldLabel}>模型</label>
                  <input
                    className={styles.input}
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                  />
                </div>
                <div>
                  <label className={styles.fieldLabel}>比例</label>
                  <select
                    className={styles.select}
                    value={aspectRatio}
                    onChange={(e) => setAspectRatio(e.target.value)}
                  >
                    <option>1:1</option>
                    <option>16:9</option>
                    <option>9:16</option>
                    <option>4:3</option>
                    <option>3:4</option>
                  </select>
                </div>
              </div>
              <div className={`${styles.formRow} ${styles.threeCols}`}>
                <div>
                  <label className={styles.fieldLabel}>张数</label>
                  <select
                    className={styles.select}
                    value={numImages}
                    onChange={(e) => setNumImages(e.target.value)}
                  >
                    <option value="1">1</option>
                    <option value="4">4</option>
                  </select>
                </div>
                <div>
                  <label className={styles.fieldLabel}>尺寸</label>
                  <select className={styles.select} value={size} onChange={(e) => setSize(e.target.value)}>
                    <option>2K</option>
                    <option>4K</option>
                    <option>1K</option>
                  </select>
                </div>
                <div>
                  <label className={styles.fieldLabel}>格式</label>
                  <select
                    className={styles.select}
                    value={outputFormat}
                    onChange={(e) => setOutputFormat(e.target.value)}
                  >
                    <option>png</option>
                    <option>jpeg</option>
                    <option>webp</option>
                  </select>
                </div>
              </div>
              <div className={styles.formRow}>
                <label className={styles.fieldLabel}>参考图 URL（每行一张，可空）</label>
                <textarea
                  className={styles.textarea}
                  placeholder="https://example.com/ref1.png\nhttps://example.com/ref2.png"
                  value={imageUrls}
                  onChange={(e) => setImageUrls(e.target.value)}
                />
              </div>
            </section>
          </div>

          <section className={styles.promptBox}>
            <div className={styles.promptInputWrap}>
              <textarea
                className={styles.textarea}
                style={{ minHeight: 120 }}
                placeholder="输入提示词，点击发送调用 Nano Banana Pro..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <button className={styles.sendBtn} onClick={generateImage} disabled={loadingGenerate}>
                发送
              </button>
            </div>
            <div className={styles.tinyRow}>
              <span>{generationStatus}</span>
              <span>图像生成中时会自动保存到当前项目 generated 目录</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
