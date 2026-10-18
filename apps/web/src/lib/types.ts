export type Scope = 'COMPANY' | 'DEPARTMENT' | 'PROJECT' | 'OWN';

export interface User {
  id: string;
  telegramId: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
  photoUrl: string | null;
  canDm: boolean;
}
export interface CompanyRef {
  id: string;
  name: string;
  roles: string[];
  status: string;
}
export interface Company {
  id: string;
  name: string;
  timezone: string;
  workDays: number[];
  workStart: string;
  workEnd: string;
  holidays: string[];
  officeLat: number | null;
  officeLng: number | null;
  officeRadiusM: number;
  reminderPolicy: Record<string, unknown>;
  digestEnabled: boolean;
  digestTime: string | null;
  plan: string;
  planUntil: string | null;
}
export interface AppContext {
  company: Company;
  roles: string[];
  departmentIds: string[];
  headOfDepartmentIds: string[];
  projectIds: string[];
  permissions: Record<string, Scope[]>;
  /** Effective per-member switches (role defaults filled in). */
  perms: MemberPerms;
  allRoles: string[];
}
export interface MemberPerms {
  createTasks: boolean;
  assignTasks: boolean;
  projectsView: 'ALL' | 'OWN';
}
export interface JoinRequest {
  id: string;
  userId: string;
  name: string;
  username: string | null;
  photoUrl: string | null;
  group: string | null;
  departmentId: string | null;
  createdAt: string;
}
export interface TgGroup {
  id: string;
  title: string;
  kind: 'TEAM' | 'CLIENT';
  departmentId: string | null;
  department: string | null;
  pending: number;
}
export interface MyJoinStatus {
  status: 'PENDING' | 'REJECTED';
  company: string;
  group: string | null;
}
export interface Department {
  id: string;
  name: string;
  kpiTemplate: string;
  headUserId: string | null;
  requireFileOnSubmit: boolean;
  color: string;
  section: 'DESIGN' | 'MEDIA' | 'NONE';
  memberCount: number;
}
export interface Member {
  userId: string;
  name: string;
  username: string | null;
  photoUrl: string | null;
  roles: string[];
  status: string;
  departmentId: string | null;
  department: string | null;
  position: string | null;
  phone: string | null;
  salary?: number | null;
  perms: Partial<MemberPerms>;
  effectivePerms: MemberPerms;
  joinedAt: string;
}
export interface Project {
  id: string;
  name: string;
  client: string | null;
  color: string;
  status: string;
  managerUserId: string | null;
  telegramChatId: number | null;
  telegramChatTitle: string | null;
  deadline: string | null;
  memberUserIds: string[];
  taskTotal: number;
  taskDone: number;
  taskOverdue: number;
  progress: number;
}
export interface TaskListItem {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  deadline: string;
  revision: number;
  projectId: string | null;
  departmentId: string | null;
  project: string | null;
  projectColor: string | null;
  assigneeUserId: string;
  reviewerUserId: string | null;
  assignee: { id: string; name: string; photoUrl: string | null };
  overdue: boolean;
  isPrivate: boolean;
  columnId: string | null;
  format: string | null;
  platform: string | null;
  links: string[];
  checklistDone: number;
  checklistTotal: number;
  comments: number;
  points: number;
  actions: string[];
  completedAt: string | null;
  createdAt: string;
  originalDeadline: string;
}
export interface BoardColumn {
  id: string;
  board: string;
  name: string;
  status: string;
  position: number;
  color: string;
}
export interface TaskDetail extends Omit<TaskListItem, 'assignee' | 'project' | 'comments'> {
  description: string | null;
  originalDeadline: string;
  createdAt: string;
  completedAt: string | null;
  project: string | null;
  department: string | null;
  assignee: { id: string; name: string; username: string | null };
  reviewer: { id: string; name: string; username: string | null } | null;
  files: Array<{ id: string; revision: number; fileName: string | null; kind: string; createdAt: string }>;
  events: Array<{ id: string; action: string; fromStatus: string | null; toStatus: string | null; comment: string | null; createdAt: string; actorName: string | null; data?: { before?: Record<string, unknown>; after?: Record<string, unknown> } }>;
  canEdit: boolean;
  comments: Array<{ id: string; body: string; createdAt: string; userId: string; name: string; photoUrl: string | null }>;
  checklist: Array<{ id: string; text: string; done: boolean; position: number }>;
}
export interface Motivation {
  score: number | null;
  stage: string | null;
  onTime: number;
  doneLate: number;
  openOverdue: number;
  averageLateHours: number;
}
export interface Scores {
  motivation: Motivation;
  kpi: {
    month: string;
    score: number | null;
    components: Record<string, number | null>;
    weights: Record<string, number>;
    bonus: number;
    toNextBand: number | null;
  };
  counts: { open: number; overdue: number; doneThisMonth: number; lateDays: number; presentDays: number; workDays: number };
}
export interface Dashboard {
  me: Scores;
  team: Array<Scores & { userId: string; name: string; photoUrl: string | null; position: string | null; departmentId: string | null }>;
  totals: { people: number; open: number; overdue: number; doneThisMonth: number; presentToday: number; lateToday: number; avgMotivation: number | null; atRisk: number };
}
export interface Today {
  day: string;
  workingDay: boolean;
  startsAt: string;
  endsAt: string;
  checkIn: string | null;
  checkOut: string | null;
  lateMinutes: number;
  needsLocation: boolean;
}
export interface Invitation {
  id: string;
  token: string;
  role: string;
  departmentId: string | null;
  position: string | null;
  expiresAt: string;
  maxUses: number;
  uses: number;
  revoked: boolean;
  link: string;
}

export interface AttendanceDay {
  date: string;
  weekday: number;
  working: boolean;
  status: 'ON_TIME' | 'LATE' | 'ABSENT' | 'OFF' | 'FUTURE' | 'BEFORE_JOIN';
  checkIn: string | null;
  checkOut: string | null;
  lateMinutes: number;
  note: string | null;
}
export interface AttendanceMonth {
  month: string;
  userId: string;
  days: AttendanceDay[];
  summary: { workDays: number; onTime: number; late: number; absent: number };
}

export interface ShootPerson {
  id: string;
  name: string;
  photoUrl: string | null;
}
export interface Shoot {
  id: string;
  title: string;
  type: string;
  status: string;
  day: string;
  startTime: string;
  endTime: string;
  location: string | null;
  notes: string | null;
  projectId: string | null;
  project: string | null;
  color: string;
  crew: ShootPerson[];
  canEdit: boolean;
}
export interface ShootConflict {
  userId: string;
  shootId: string;
  title: string;
  startTime: string;
  endTime: string;
}

