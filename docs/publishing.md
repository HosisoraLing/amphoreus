# 发布包与源码公开

本项目的 npm 包名为 `@hosisora_ling/dsh-amphoreus`。未加 scope 的 `dsh-amphoreus` 属于其他作者，不能覆盖，也不要把安装命令指向那个包。

## 构建并准备包

```sh
pnpm install --frozen-lockfile
pnpm check
npm pack --dry-run
npm pack --pack-destination /absolute/private/release
```

检查生成的包中包括 `lib`、`src`、构建配置、`source-lock.yaml`、README、LICENSE、NOTICE、第三方声明和 vendor 许可。包中不应出现 `.git`、运行数据库、账户配置、工作区、原生日志、人设、作品、图片库或凭证。包内的展示和测试资料必须为合成数据。

npm 会省略根目录的 `pnpm-lock.yaml`，所以打包前仅将同一份公开构建锁复制为 `source-lock.yaml`，不安装依赖、不执行发布。需要从 tarball 重建时，先将它复制回 `pnpm-lock.yaml`，再执行文档中的 pnpm 构建命令。

npm 包同时提供对应源码和构建说明；仓库源码与包内版本应保持一致。AGPLv3 不要求附带部署者的个人资料或服务凭证。

## 手动发布到 npm

在拥有 `hosisora_ling` scope 的账户中登录，核对包名和版本，再发布已检查的 tarball：

```sh
npm login
npm whoami
npm publish /absolute/private/release/hosisora_ling-dsh-amphoreus-0.1.0.tgz --access public
```

按 npm 提示完成账户验证。已发布的同一版本号不能覆盖，后续发布需要提升版本。本项目不在构建、安装或打包脚本中自动执行发布。

## GitHub 可见性

更改可见性前，检查即将公开的所有分支、标签及历史，而不只检查最新工作树。历史中的私人标识不会因最新文件已清理而消失；如需重写已有历史，应先获得维护者明确授权，并在公开范围之外保存原历史备份。

源码包和 npm tarball 不携带 Git 历史；它们的内容检查不能替代仓库历史检查。更改 GitHub 可见性与发布 npm 是两项独立操作。
