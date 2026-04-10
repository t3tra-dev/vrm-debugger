import { defineConfig } from 'vite';

// GitHub Actions 上では GITHUB_REPOSITORY が "owner/repo" 形式で提供される
const base = process.env.GITHUB_REPOSITORY
  ? `/${process.env.GITHUB_REPOSITORY.split('/')[1]}/`
  : '/';

export default defineConfig({ base });
