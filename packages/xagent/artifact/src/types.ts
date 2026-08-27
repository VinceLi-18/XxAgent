import type {
  XAgentArtifactCompleteInput as BackendArtifactCompleteInput,
  XAgentArtifactDetail as BackendArtifactDetail,
  XAgentArtifactScope as BackendArtifactScope,
  XAgentArtifactStatus as BackendArtifactStatus,
  XAgentArtifactSummary as BackendArtifactSummary,
  XAgentArtifactUpload as BackendArtifactUpload,
  XAgentArtifactUploadInput as BackendArtifactUploadInput,
  XAgentArtifactVersionSummary as BackendArtifactVersionSummary,
} from '@xagent/dsh-backend-client'
import type { XAgentAuthenticatedRequestScope } from '@xagent/dsh-principal'

/** 资料安全处理状态。 */
export type XAgentArtifactStatus = BackendArtifactStatus

/** 当前资料所属的私人或项目范围。 */
export type XAgentArtifactScope = BackendArtifactScope

/** 资料列表中的安全摘要。 */
export type XAgentArtifactSummary = BackendArtifactSummary

/** 资料详情中的不可变版本摘要。 */
export type XAgentArtifactVersionSummary = BackendArtifactVersionSummary

/** 资料详情、版本历史与当前编辑能力。 */
export type XAgentArtifactDetail = BackendArtifactDetail

/** 创建资料或新版本暂存上传的输入。 */
export type XAgentArtifactUploadInput = BackendArtifactUploadInput

/** 完成暂存上传的大小、摘要和幂等输入。 */
export type XAgentArtifactCompleteInput = BackendArtifactCompleteInput

/** Browser 直接 PUT 暂存正文的短期授权。 */
export type XAgentArtifactUpload = BackendArtifactUpload

/** Authorizer 使用的非 Remote 请求作用域入口。 */
export interface XAgentArtifactScopeRunner {
  withRequest<T>(scope: XAgentAuthenticatedRequestScope, operation: () => Promise<T>): Promise<T>
}

/** 浏览器可见的固定 XAgent Artifact Remote。 */
export interface XAgentArtifactRemote {
  list(signal?: AbortSignal): Promise<readonly XAgentArtifactSummary[]>
  detail(artifactId: string, signal?: AbortSignal): Promise<XAgentArtifactDetail>
  createUpload(input: XAgentArtifactUploadInput, signal?: AbortSignal): Promise<XAgentArtifactUpload>
  createVersionUpload(
    artifactId: string,
    input: XAgentArtifactUploadInput,
    signal?: AbortSignal,
  ): Promise<XAgentArtifactUpload>
  completeUpload(
    uploadId: string,
    input: XAgentArtifactCompleteInput,
    signal?: AbortSignal,
  ): Promise<XAgentArtifactDetail>
  retry(versionId: string, idempotencyKey: string, signal?: AbortSignal): Promise<XAgentArtifactDetail>
  preview(versionId: string, signal?: AbortSignal): Promise<{ readonly url: string }>
  download(versionId: string, signal?: AbortSignal): Promise<{ readonly url: string }>
}
