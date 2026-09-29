/**
 * 링크 편집기용 저장소 — GitHub API 로 PF_private 을 직접 읽고 쓴다.
 *
 * 저장은 draft 브랜치에 커밋으로 쌓이고, publish() 가 draft 를 main 에 합친다.
 * main 에 합쳐지면 .github/workflows/deploy.yml 이 공개 사이트를 배포한다.
 * 토큰은 이 저장소의 Contents 읽기·쓰기 권한만 있으면 된다.
 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

export function createGitHubBackend({ token, owner = "sulj1237", repo = "PF_private", draft = "draft", base = "main", fetchImpl = fetch }) {
  const root = `https://api.github.com/repos/${owner}/${repo}`;
  let paths = []; // draft 브랜치의 파일 목록
  const newline = {}; // 파일 끝 줄바꿈 유무 — 저장할 때 그대로 둔다
  const imageCache = new Map();

  async function gh(path, opts = {}) {
    const r = await fetchImpl(path.startsWith("http") ? path : root + path, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...opts.headers,
      },
    });
    if (!r.ok && !(opts.allow ?? []).includes(r.status)) {
      const j = await r.json().catch(() => ({}));
      const e = new Error(r.status === 401 ? "토큰이 맞지 않거나 만료되었습니다" : j.message || r.statusText);
      e.status = r.status;
      throw e;
    }
    return r;
  }
  const json = async (path, opts) => (await gh(path, opts)).json();
  const post = (path, body, allow) => gh(path, { method: "POST", body: JSON.stringify(body), allow });
  const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

  async function raw(path) {
    const r = await gh(`/contents/${enc(path)}?ref=${draft}`, { headers: { Accept: "application/vnd.github.raw+json" } });
    return r;
  }
  async function readJson(path) {
    const text = await (await raw(path)).text();
    newline[path] = text.endsWith("\n");
    return JSON.parse(text);
  }
  async function refreshTree() {
    const t = await json(`/git/trees/${draft}?recursive=1`);
    paths = t.tree.filter((e) => e.type === "blob").map((e) => e.path);
  }

  /** 여러 파일을 커밋 하나로 draft 에 올린다. files: { 경로: { content, encoding } } */
  async function commit(files, message) {
    for (let attempt = 0; ; attempt++) {
      const ref = await json(`/git/ref/heads/${draft}`);
      const parent = await json(`/git/commits/${ref.object.sha}`);
      const tree = await Promise.all(
        Object.entries(files).map(async ([path, f]) => {
          const blob = await (await post(`/git/blobs`, f)).json();
          return { path, mode: "100644", type: "blob", sha: blob.sha };
        }),
      );
      const newTree = await (await post(`/git/trees`, { base_tree: parent.tree.sha, tree })).json();
      const c = await (await post(`/git/commits`, { message, tree: newTree.sha, parents: [ref.object.sha] })).json();
      const r = await gh(`/git/refs/heads/${draft}`, { method: "PATCH", body: JSON.stringify({ sha: c.sha }), allow: [422] });
      if (r.ok) break;
      if (attempt >= 2) throw new Error("다른 곳에서 동시에 저장되어 반영하지 못했습니다. 새로고침 후 다시 저장하세요");
    }
    await refreshTree();
  }

  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  return {
    remote: true,
    siteUrl: `https://${owner.toLowerCase()}.github.io/case-studies`,
    repoUrl: `https://github.com/${owner}/${repo}`,

    /** draft 가 없으면 main 에서 만들고, main 의 새 변경을 draft 로 가져온다 */
    async init() {
      const ref = await gh(`/git/ref/heads/${draft}`, { allow: [404] });
      if (ref.status === 404) {
        const main = await json(`/git/ref/heads/${base}`);
        await post(`/git/refs`, { ref: `refs/heads/${draft}`, sha: main.object.sha });
      } else {
        const c = await json(`/compare/${draft}...${base}`);
        if (c.ahead_by > 0 && c.behind_by === 0) {
          // draft 에 발행 안 된 수정이 없으면 main 으로 그대로 당긴다
          await gh(`/git/refs/heads/${draft}`, { method: "PATCH", body: JSON.stringify({ sha: (await json(`/git/ref/heads/${base}`)).object.sha }) });
        } else if (c.ahead_by > 0) {
          const m = await post(`/merges`, { base: draft, head: base, commit_message: `sync: ${base} → ${draft}` }, [409]);
          if (m.status === 409) throw new Error(`${base} 와 ${draft} 의 같은 곳이 서로 다르게 바뀌어 합칠 수 없습니다. 로컬에서 정리가 필요합니다`);
        }
      }
      await refreshTree();
    },

    async projects() {
      const slugs = paths.map((p) => p.match(/^content\/projects\/([^/]+)\/_project\.json$/)?.[1]).filter(Boolean);
      const list = await Promise.all(
        slugs.map(async (slug) => {
          const m = await readJson(`content/projects/${slug}/_project.json`);
          return { slug, title: m.title, order: m.order, hidden: m.hidden === true };
        }),
      );
      return list.sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.slug.localeCompare(b.slug));
    },

    async project(slug) {
      const dir = `content/projects/${slug}/`;
      const ids = [...new Set(paths.filter((p) => p.startsWith(dir) && /\.(json|md)$/.test(p) && !p.slice(dir.length).includes("/")).map((p) => p.slice(dir.length).replace(/\.(json|md)$/, "")))].filter((id) => id !== "_project").sort();
      const sections = {};
      await Promise.all(ids.map(async (id) => {
        if (paths.includes(`${dir}${id}.json`)) sections[id] = await readJson(`${dir}${id}.json`);
        else sections[id] = { __markdown: true, content: await (await raw(`${dir}${id}.md`)).text() };
      }));
      return { meta: await readJson(`${dir}_project.json`), sections };
    },

    async profile() {
      return readJson("content/profile/profile.json");
    },

    async saveProfile(data) {
      const path = "content/profile/profile.json";
      await commit({ [path]: { content: JSON.stringify(data, null, 2) + (newline[path] ? "\n" : ""), encoding: "utf-8" } }, "edit(profile): 프로필");
    },

    /** files: { "meta" | 섹션id: 데이터 } */
    async save(slug, files) {
      const out = {};
      for (const [id, data] of Object.entries(files)) {
        const markdown = id !== "meta" && data?.__markdown === true;
        const path = `content/projects/${slug}/${id === "meta" ? "_project" : id}${markdown ? ".md" : ".json"}`;
        out[path] = { content: markdown ? data.content : JSON.stringify(data, null, 2) + (newline[path] ? "\n" : ""), encoding: "utf-8" };
      }
      await commit(out, `edit(${slug}): ${Object.keys(files).map((id) => (id === "meta" ? "기본 정보" : id)).join(", ")}`);
    },

    async upload(slug, file) {
      const ext = (file.name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
      if (!IMAGE_EXT.test(ext)) throw new Error("이미지 파일만 올릴 수 있습니다");
      let stem = file.name.slice(0, -ext.length).replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || `image-${Date.now()}`;
      const dir = `public/images/uploads/${slug}/`;
      let name = stem + ext;
      for (let i = 2; paths.includes(dir + name); i++) name = `${stem}-${i}${ext}`;
      const content = b64(await file.arrayBuffer());
      await commit({ [dir + name]: { content, encoding: "base64" } }, `upload(${slug}): ${name}`);
      const src = `/images/uploads/${slug}/${name}`;
      imageCache.set(src, URL.createObjectURL(file));
      return src;
    },

    async images() {
      return paths.filter((p) => p.startsWith("public/images/") && IMAGE_EXT.test(p)).map((p) => p.slice("public".length)).sort();
    },

    /** 비공개 저장소라 이미지도 토큰으로 받아 화면용 주소를 만든다 */
    async imageUrl(src) {
      if (!imageCache.has(src)) {
        imageCache.set(src, raw(`public${src}`).then(async (r) => URL.createObjectURL(await r.blob())));
      }
      return imageCache.get(src);
    },

    /** 발행 대기 중인 저장 수 (동기화용 합치기 커밋은 세지 않는다). 바뀐 파일이 없으면 0 */
    async pending() {
      const c = await json(`/compare/${base}...${draft}`);
      if (!c.files?.length) return 0;
      return c.commits.filter((x) => x.parents.length === 1).length || 1;
    },

    async publish() {
      const r = await post(`/merges`, { base, head: draft, commit_message: `publish: ${draft} → ${base}` }, [409]);
      if (r.status === 409) throw new Error("main 과 겹치는 변경이 있어 발행하지 못했습니다. 로컬에서 정리가 필요합니다");
      return r.status === 201;
    },
  };
}
