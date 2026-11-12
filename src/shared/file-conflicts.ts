import { t } from './i18n'
export type ConflictChoice = 'skip' | 'keep' | 'cancel' | 'merge' | 'overwrite'
type Conflict = { mergeable?: boolean; replaceable?: boolean }

/** Batch decisions are scoped to one task and to compatible object capabilities. */
export class ConflictPolicy {
  private choices = new Map<string, ConflictChoice>()
  private kind(conflict: Conflict): string { return conflict.mergeable ? 'directory' : conflict.replaceable ? 'file' : 'other' }
  validate(conflict: Conflict, choice: ConflictChoice): void {
    if (!['skip', 'keep', 'cancel', 'merge', 'overwrite'].includes(choice) || (choice === 'merge' && !conflict.mergeable) || (choice === 'overwrite' && !conflict.replaceable)) throw new Error(t("此冲突不支持所选处理方式"))
  }
  get(conflict: Conflict): ConflictChoice | undefined { return this.choices.get(this.kind(conflict)) }
  remember(conflict: Conflict, choice: ConflictChoice): void {
    this.validate(conflict, choice)
    if (choice !== 'cancel') this.choices.set(this.kind(conflict), choice)
  }
}
