import * as Sentry from "@sentry/node";
import axios, { AxiosRequestConfig } from "axios";
import * as zip from "jszip";
import * as LRU from "lru-cache";
import fetch from "node-fetch";
import { encode } from "base-64";
import log from "../../utils/log";
import { IGitInfo, ITree } from "./push";

const API_URL = "https://api.github.com";
const REPO_BASE_URL = API_URL + "/repos";

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

const NOT_FOUND_MESSAGE =
  "Could not find the specified repository or directory";

function buildRepoApiUrl(username: string, repo: string) {
  return `${REPO_BASE_URL}/${username}/${repo}`;
}

function buildPullApiUrl(username: string, repo: string, pull: number) {
  return `${buildRepoApiUrl(username, repo)}/pulls/${pull}`;
}

function buildCommitApiUrl(username: string, repo: string, commitSha: string) {
  return `${REPO_BASE_URL}/${username}/${repo}/commits/${commitSha}`;
}

function buildTreesApiUrl(username: string, repo: string, treeSha: string) {
  return `${REPO_BASE_URL}/${username}/${repo}/git/trees/${treeSha}`;
}

function buildContentsApiUrl(username: string, repo: string, path: string) {
  return `${REPO_BASE_URL}/${username}/${repo}/contents/${path}`;
}

function buildCompareApiUrl(
  username: string,
  repo: string,
  baseRef: string,
  headRef: string
) {
  return `${buildRepoApiUrl(username, repo)}/compare/${baseRef}...${headRef}`;
}

function createAxiosRequestConfig(token?: string): AxiosRequestConfig {
  const Accept = "application/vnd.github.v3+json";
  return token
    ? {
      headers: { Accept, Authorization: `Bearer ${token}` },
    }
    : {
      auth: {
        username: GITHUB_CLIENT_ID!,
        password: GITHUB_CLIENT_SECRET!,
      },
      headers: { Accept },
    };
}

function buildContentsUrl(
  username: string,
  repo: string,
  branch: string,
  path: string
) {
  return `${buildRepoApiUrl(username, repo)}/contents/${path}?ref=${branch}`;
}

function buildCommitsUrl(
  username: string,
  repo: string,
  branch: string,
  path: string
) {
  return `${buildRepoApiUrl(username, repo)}/commits/${branch}?path=${path}`;
}

function buildCommitsByPathUrl(
  username: string,
  repo: string,
  branch: string,
  path: string
) {
  return `${buildRepoApiUrl(
    username,
    repo
  )}/commits?sha=${branch}&path=${path}`;
}

interface IRepoResponse {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
}

interface ICompareResponse {
  files: Array<{
    sha: string;
    filename: string;
    status: "added" | "deleted";
    additions: number;
    deletions: number;
    changes: number;
    contents_url: string;
    patch?: string;
  }>;
  base_commit: {
    sha: string;
  };
  merge_base_commit: {
    sha: string;
  };
  commits: Array<{ sha: string }>;
}

interface IContentResponse {
  content: string;
  encoding: string;
  sha: string;
}

interface ICommitResponse {
  commit: {
    tree: {
      sha: string;
    };
  };
}

interface IPrResponse {
  number: number;
  repo: string;
  username: string;
  branch: string;
  state: string;
  merged: boolean;
  mergeable: boolean;
  mergeable_state: string;
  commitSha: string;
  baseCommitSha: string;
  rebaseable: boolean;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
}

interface IDeleteContentResponse {
  commit: {
    sha: string;
  };
}

export async function getComparison(
  username: string,
  repo: string,
  baseRef: string,
  headRef: string,
  token: string
) {
  const url = buildCompareApiUrl(username, repo, baseRef, headRef);

  const response: { data: ICompareResponse } = await axios({
    url,
    ...createAxiosRequestConfig(token),
  });

  return response.data;
}

export async function getContent(url: string, token: string) {
  const response: { data: IContentResponse } = await axios({
    url,
    ...createAxiosRequestConfig(token),
  });

  return response.data;
}

export async function getRepo(username: string, repo: string, token?: string) {
  const url = buildRepoApiUrl(username, repo);

  const response: { data: IRepoResponse } = await axios({
    url,
    ...createAxiosRequestConfig(token),
  });

  return response.data;
}

export async function getTreeWithDeletedFiles(
  username: string,
  repo: string,
  treeSha: string,
  deletedFiles: string[],
  token: string,
  path = []
) {
  async function fetchTree(sha: string) {
    const url = buildTreesApiUrl(username, repo, sha);

    const response: { data: ITreeResponse } = await axios({
      url,
      ...createAxiosRequestConfig(token),
    });

    return response.data.tree;
  }

  let tree = await fetchTree(treeSha);

  return deletedFiles.reduce(
    (aggr, file) =>
      aggr.then(async (tree) => {
        const parts = file.split("/");
        parts.pop();
        const dirs = parts.reduce<string[]>((aggr, part, index) => {
          return aggr.concat(
            aggr[index - 1] ? aggr[index - 1] + "/" + part : part
          );
        }, []);

        const newTree = await dirs.reduce(
          (subaggr, dir) =>
            subaggr.then(async (tree) => {
              const treeIndex = tree.findIndex(
                (item) => item.type === "tree" && item.path === dir
              );

              if (treeIndex >= 0) {
                const nestedTree = await fetchTree(tree[treeIndex].sha);
                const newTree = tree.concat(
                  nestedTree.map((item) => ({
                    ...item,
                    path: dir + "/" + item.path,
                  }))
                );
                newTree.splice(treeIndex, 1);

                return newTree;
              }

              return tree;
            }),
          Promise.resolve(tree)
        );

        return newTree.filter((item) => item.path !== file);
      }),
    Promise.resolve(tree)
  );
}

export async function getCommitTreeSha(
  username: string,
  repo: string,
  commitSha: string,
  token: string
) {
  const url = buildCommitApiUrl(username, repo, commitSha);

  const response: { data: ICommitResponse } = await axios({
    url,
    ...createAxiosRequestConfig(token),
  });

  return response.data.commit.tree.sha;
}

export async function getLatestCommitShaOfFile(
  username: string,
  repo: string,
  branch: string,
  path: string,
  token?: string
): Promise<string | undefined> {
  const url = buildCommitsByPathUrl(username, repo, branch, path);
  const response: { data: { sha: string }[] } = await axios({
    url,
    ...createAxiosRequestConfig(token),
  });

  if (response.data[0]) {
    return response.data[0].sha;
  }

  return undefined;
}

export async function isRepoPrivate(
  username: string,
  repo: string,
  token: string
) {
  const data = await getRepo(username, repo, token);

  return data.private;
}

interface RightsResponse {
  permissions: {
    admin: boolean;
    push: boolean;
    pull: boolean;
  };
}

/**
 * Fetch the permissions of a user on a specific repository.
 */
export async function fetchRights(
  username: string,
  repo: string,
  token?: string
): Promise<"admin" | "write" | "read" | "none"> {
  const url = buildRepoApiUrl(username, repo);

  try {
    const response: { data: RightsResponse } = await axios({
      url,
      ...createAxiosRequestConfig(token),
    });

    // No token
    if (!response.data.permissions) {
      return "none";
    }

    if (response.data.permissions.admin) {
      return "admin";
    }

    if (response.data.permissions.push) {
      return "write";
    }

    return "read";
  } catch (e) {
    if (
      e.response &&
      (e.response.status === 403 || e.response.status === 401)
    ) {
      return "none";
    } else {
      throw e;
    }
  }
}

interface ITreeResponse {
  sha: string;
  tree: ITree;
  truncated: boolean;
  url: string;
}

interface IBlobResponse {
  url: string;
  sha: string;
}

export async function createPr(
  base: {
    username: string;
    repo: string;
    branch: string;
  },
  head: {
    username: string;
    repo: string;
    branch: string;
  },
  title: string,
  body: string,
  token: string
): Promise<IPrResponse> {
  const { data } = await axios.post(
    `${buildRepoApiUrl(base.username, base.repo)}/pulls`,
    {
      base: base.branch,
      head: `${base.username === head.username ? "" : head.username + ":"}${head.branch
        }`,
      title,
      body,
      maintainer_can_modify: true,
    },
    createAxiosRequestConfig(token)
  );

  return {
    number: data.number,
    repo: data.head.repo.name,
    username: data.head.repo.owner.login,
    commitSha: data.head.sha,
    branch: data.head.ref,
    merged: data.merged,
    state: data.state,
    mergeable: data.mergeable,
    mergeable_state: data.mergeable_state,
    rebaseable: data.rebaseable,
    additions: data.additions,
    changed_files: data.changed_files,
    commits: data.commits,
    baseCommitSha: data.base.sha,
    deletions: data.deletions,
  };
}

export async function createBlob(
  username: string,
  repo: string,
  content: string,
  encoding: "utf-8" | "base64",
  token: string
) {
  const response: { data: IBlobResponse } = await axios.post(
    `${buildRepoApiUrl(username, repo)}/git/blobs`,
    { content: content, encoding },
    createAxiosRequestConfig(token)
  );

  return response.data;
}

interface ICreateTreeResponse {
  sha: string;
  url: string;
  tree: ITree;
}

export async function createTree(
  username: string,
  repo: string,
  tree: ITree,
  baseTreeSha: string | null,
  token: string
) {
  const response: { data: ICreateTreeResponse } = await axios.post(
    `${buildRepoApiUrl(username, repo)}/git/trees`,
    { base_tree: baseTreeSha, tree },
    createAxiosRequestConfig(token)
  );

  return response.data;
}

interface ICreateCommitResponse {
  sha: string;
  url: string;
  author: {
    date: string;
    name: string;
    email: string;
  };
  committer: {
    date: string;
    name: string;
    email: string;
  };
  message: string;
}

/**
 * Create a commit from the given tree
 */
export async function createCommit(
  username: string,
  repo: string,
  treeSha: string,
  parentCommitShas: string[],
  message: string,
  token: string
) {
  const response: { data: ICreateCommitResponse } = await axios.post(
    `${buildRepoApiUrl(username, repo)}/git/commits`,
    { tree: treeSha, message, parents: parentCommitShas },
    createAxiosRequestConfig(token)
  );

  return response.data;
}

interface IUpdateReferenceResponse {
  ref: string;
  url: string;
}

export async function updateReference(
  username: string,
  repo: string,
  branch: string,
  commitSha: string,
  token: string
) {
  const response: { data: IUpdateReferenceResponse } = await axios.patch(
    `${buildRepoApiUrl(username, repo)}/git/refs/heads/${branch}`,
    { sha: commitSha, force: true },
    createAxiosRequestConfig(token)
  );

  return response.data;
}

interface ICreateReferenceResponse {
  ref: string;
  url: string;
  object: {
    type: string;
    sha: string;
    url: string;
  };
}

export async function createReference(
  username: string,
  repo: string,
  branch: string,
  refSha: string,
  token: string
) {
  const response: { data: ICreateReferenceResponse } = await axios.post(
    `${buildRepoApiUrl(username, repo)}/git/refs`,
    { ref: `refs/heads/${branch}`, sha: refSha },
    createAxiosRequestConfig(token)
  );

  return response.data;
}

interface ICreateForkResponse {
  name: string;
  full_name: string;
  description: string;
  private: boolean;
  fork: boolean;
}

export async function createFork(
  username: string,
  repo: string,
  token: string
) {
  const response: { data: ICreateForkResponse } = await axios.post(
    `${buildRepoApiUrl(username, repo)}/forks`,
    {},
    createAxiosRequestConfig(token)
  );

  return response.data;
}

interface ICreateRepoResponse {
  name: string;
  full_name: string;
  description: string;
  private: false;
  fork: false;
  url: string;
  default_branch: string;
}

export async function getDefaultBranch(
  username: string,
  repo: string,
  token?: string
) {
  const data = await getRepo(username, repo, token);

  return data.default_branch;
}

export async function createRepo(
  username: string,
  repo: string,
  token: string,
  privateRepo: boolean = false
) {
  const response: { data: ICreateRepoResponse } = await axios.post(
    `${API_URL}/user/repos`,
    {
      name: repo,
      description: "Created with CodeSandbox",
      homepage: `https://codesandbox.io/s/github/${username}/${repo}`,
      auto_init: true,
      private: privateRepo,
    },
    createAxiosRequestConfig(token)
  );

  return response.data;
}

/**
 * Check if repository exists
 */
export async function doesRepoExist(username: string, repo: string) {
  try {
    const response = await axios.get(
      buildRepoApiUrl(username, repo),
      createAxiosRequestConfig()
    );

    return true;
  } catch (e) {
    if (e.response && e.response.status === 404) {
      return false;
    }

    throw e;
  }
}

interface CommitResponse {
  commitSha: string;
  username: string;
  repo: string;
  branch: string;
  path: string;
}

const shaCache = LRU({
  max: 500,
  maxAge: 1000 * 5, // 5 seconds
});

const etagCache = LRU<string, { etag: string; sha: string }>({
  max: 50000,
});

export function resetShaCache(gitInfo: IGitInfo) {
  const { username, repo, branch, path = "" } = gitInfo;

  return shaCache.del(username + repo + branch + path);
}

export async function fetchRepoInfo(
  username: string,
  repo: string,
  branch: string,
  path: string = "",
  skipCache: boolean = false,
  userToken?: string
): Promise<CommitResponse> {
  try {
    const cacheId = username + repo + branch + path;
    // We cache the latest retrieved sha for a limited time, so we don't spam the
    // GitHub API for every request
    let latestSha = shaCache.get(cacheId) as string;

    if (!latestSha || skipCache) {
      const url = buildCommitsUrl(username, repo, branch, path);

      const headers: { "If-None-Match"?: string } = {};

      const etagCacheResponse = etagCache.get(cacheId);
      if (etagCacheResponse) {
        // Use an ETag header so duplicate requests don't count towards the limit
        headers["If-None-Match"] = etagCacheResponse.etag;
      }

      const defaultConfig = createAxiosRequestConfig(userToken);
      const response = await axios({
        url,
        validateStatus: function (status) {
          // Axios sees 304 (Not Modified) as an error. We don't want that.
          return status < 400; // Reject only if the status code is greater than or equal to 400
        },
        ...defaultConfig,
        headers: {
          ...defaultConfig.headers,
          ...headers,
        },
      });

      if (response.status === 304 && etagCacheResponse) {
        latestSha = etagCacheResponse.sha;
      } else {
        latestSha = response.data.sha;

        const etag = response.headers.etag;

        // Only save towards the cache if there is no userToken. For people with a userToken
        // we have 12k requests per hour to use. Won't hit that ever.
        if (etag && !userToken) {
          etagCache.set(cacheId, {
            etag,
            sha: response.data.sha,
          });
        }
      }

      shaCache.set(cacheId, latestSha);
    }

    return {
      commitSha: latestSha,
      username,
      repo,
      branch,
      path,
    };
  } catch (e) {
    // There is a chance that the branch contains slashes, we try to fix this
    // by requesting again with the first part of the path appended to the branch
    // when a request fails (404)
    if (
      e.response &&
      (e.response.status === 404 || e.response.status === 422)
    ) {
      const [branchAddition, ...newPath] = path.split("/");
      const newBranch = `${branch}/${branchAddition}`;

      if (branchAddition !== "") {
        return await fetchRepoInfo(
          username,
          repo,
          newBranch,
          newPath.join("/"),
          false,
          userToken
        );
      }

      e.message = NOT_FOUND_MESSAGE;
    }
    Sentry.captureException(e);

    throw e;
  }
}

export async function fetchPullInfo(
  username: string,
  repo: string,
  pull: number,
  userToken?: string
): Promise<IPrResponse> {
  const url = buildPullApiUrl(username, repo, pull);

  try {
    const response = await axios({
      url,
      ...createAxiosRequestConfig(userToken),
    });

    const data = response.data;

    return {
      number: data.head.number,
      repo: data.head.repo.name,
      username: data.head.repo.owner.login,
      commitSha: data.head.sha,
      branch: data.head.ref,
      state: data.state,
      merged: data.merged,
      mergeable: data.mergeable,
      mergeable_state: data.mergeable_state,
      rebaseable: data.rebaseable,
      additions: data.additions,
      changed_files: data.changed_files,
      commits: data.commits,
      baseCommitSha: data.base.sha,
      deletions: data.deletions,
    };
  } catch (e) {
    e.message = "Could not find pull request information";
    throw e;
  }
}

const MAX_ZIP_SIZE = 128 * 1024 * 1024; // 128Mb

export async function downloadZip(
  gitInfo: IGitInfo,
  commitSha: string,
  userToken?: string
) {
  const repoUrl = buildRepoApiUrl(gitInfo.username, gitInfo.repo);
  const url = `${repoUrl}/zipball/${commitSha}`;
  const Accept = "application/vnd.github.v3+json";
  const buffer: Buffer = await fetch(url, {
    headers: {
      Authorization: userToken
        ? `Bearer ${userToken}`
        : `Basic ${encode(`${GITHUB_CLIENT_ID}:${GITHUB_CLIENT_SECRET}`)}`,
      Accept,
    },
  }).then((res) => {
    if (+res.headers.get("Content-Length") > MAX_ZIP_SIZE) {
      throw new Error("This repo is too big to import");
    }

    return res.buffer();
  });

  const loadedZip = await zip.loadAsync(buffer);

  return loadedZip;
}
