import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Department, Member, Project } from './types';

export const useMembers = () => useQuery({ queryKey: ['members'], queryFn: () => api<Member[]>('/members') });
export const useProjects = () => useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/projects') });
export const useDepartments = () => useQuery({ queryKey: ['departments'], queryFn: () => api<Department[]>('/departments') });
