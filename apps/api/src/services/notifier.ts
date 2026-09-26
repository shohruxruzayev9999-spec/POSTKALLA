import type { ReminderStep, TaskAction } from '@retarget/shared';

export interface Person {
  id: string;
  name: string;
  username: string | null;
  telegramId: number;
}

/** A task as the bot needs to render it. */
export interface TaskCard {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: string;
  deadline: Date;
  revision: number;
  projectName: string | null;
  assignee: Person;
  reviewer: Person | null;
  groupChatId: number | null;
  groupMessageId: number | null;
}

export interface ReminderDelivery {
  card: TaskCard;
  step: ReminderStep;
  /** Private chats to notify (assignee, department head, CEO) by Telegram id. */
  privateChatIds: number[];
  includeGroup: boolean;
  /** Last live reminder per chat, to be deleted before the new one is sent. */
  previous: Array<{ chatId: number; messageId: number }>;
}

export interface SentMessage {
  chatId: number;
  messageId: number;
}

/**
 * Everything the domain tells the outside world. The Telegram bot implements it; tests use a
 * recording fake. Delivery failures never roll back business changes.
 */
export interface Notifier {
  /** Post (or edit in place) the task card with status buttons in the project group. */
  upsertTaskCard(card: TaskCard): Promise<SentMessage | null>;
  taskChanged(card: TaskCard, action: TaskAction, actorName: string, comment: string | null): Promise<void>;
  sendReminder(d: ReminderDelivery): Promise<SentMessage[]>;
  direct(telegramId: number, text: string): Promise<void>;
}

export class NullNotifier implements Notifier {
  async upsertTaskCard(): Promise<SentMessage | null> {
    return null;
  }
  async taskChanged(): Promise<void> {}
  async sendReminder(): Promise<SentMessage[]> {
    return [];
  }
  async direct(): Promise<void> {}
}
