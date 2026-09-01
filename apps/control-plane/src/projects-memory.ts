import type {
  CaptureDefaultOutcome,
  CaptureDefaultRecord,
  ProjectRepository,
  ScanJobRecord,
  StoredProject,
} from './projects.js'

export interface InMemoryProjectRepositoryOptions {
  onProjectCreated?: (project: StoredProject) => void
  scanJob?: (
    organizationId: string,
    projectId: string,
    jobId: string,
  ) => Promise<ScanJobRecord | null>
}

function projectKey(organizationId: string, projectId: string): string {
  return `${organizationId}:${projectId}`
}

function scanKey(organizationId: string, projectId: string, jobId: string): string {
  return `${organizationId}:${projectId}:${jobId}`
}

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, StoredProject>()
  private readonly scans = new Map<string, ScanJobRecord>()
  private readonly captures = new Map<
    string,
    Extract<CaptureDefaultOutcome, { outcome: 'created' | 'existing' }>['capture']
  >()

  constructor(private readonly options: InMemoryProjectRepositoryOptions = {}) {}

  seedProject(project: StoredProject): void {
    this.projects.set(projectKey(project.organizationId, project.projectId), structuredClone(project))
  }

  seedScanJob(organizationId: string, projectId: string, scan: ScanJobRecord): void {
    this.scans.set(scanKey(organizationId, projectId, scan.jobId), structuredClone(scan))
  }

  async createProject(project: StoredProject): Promise<boolean> {
    const duplicate = [...this.projects.values()].some(
      (candidate) =>
        candidate.organizationId === project.organizationId && candidate.name === project.name,
    )
    if (duplicate) return false
    this.seedProject(project)
    this.options.onProjectCreated?.(project)
    return true
  }

  async listProjects(organizationId: string): Promise<StoredProject[]> {
    return [...this.projects.values()]
      .filter((project) => project.organizationId === organizationId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((project) => structuredClone(project))
  }

  async scanJob(
    organizationId: string,
    projectId: string,
    jobId: string,
  ): Promise<ScanJobRecord | null> {
    if (this.options.scanJob) return this.options.scanJob(organizationId, projectId, jobId)
    const scan = this.scans.get(scanKey(organizationId, projectId, jobId))
    return scan ? structuredClone(scan) : null
  }

  async captureDefault(record: CaptureDefaultRecord): Promise<CaptureDefaultOutcome> {
    const key = projectKey(record.organizationId, record.projectId)
    const project = this.projects.get(key)
    if (!project) return { outcome: 'projectMissing' }
    const existing = this.captures.get(key)
    if (existing) return { outcome: 'existing', capture: structuredClone(existing) }
    const capture = {
      revision: {
        setupId: record.setupId,
        setupRevisionId: record.setupRevisionId,
        revisionNumber: 1,
        sourceScanJobId: record.scanJobId,
        itemCount: record.items.length,
        createdAt: record.createdAt,
      },
      items: structuredClone([...record.items]),
    }
    this.captures.set(key, capture)
    project.defaultRevision = structuredClone(capture.revision)
    project.updatedAt = record.createdAt
    return { outcome: 'created', capture: structuredClone(capture) }
  }
}
