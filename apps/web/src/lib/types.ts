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
}
export interface AppContext {
  company: Company;
  roles: string[];
  departmentIds: string[];
  headOfDepartmentIds: string[];
  projectIds: string[];
  permissions: Record<string, Scope[]>;
  allRoles: string[];
}
export interface Department {
  id: string;
  name: string;
  kpiTemplate: string;
  headUserId: string | null;
  requireFileOnSubmit: boolean;
  color: string;
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
  actions: string[];
}
export interface TaskDetail extends Omit<TaskListItem, 'assignee' | 'project'> {
  description: string | null;
  points: number;
  originalDeadline: string;
  createdAt: string;
  completedAt: string | null;
  project: string | null;
  department: string | null;
  assignee: { id: string; name: string; username: string | null };
  reviewer: { id: string; name: string; username: string | null } | null;
  files: Array<{ id: string; revision: number; fileName: string | null; kind: string; createdAt: string }>;
  events: Array<{ id: string; action: string; fromStatus: string | null; toStatus: string | null; comment: string | null; createdAt: string; actorName: string | null }>;
  canEdit: boolean;
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
