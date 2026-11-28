import { t } from '../shared/i18n'
import { hostDisplayName, type Host } from '../shared/types'
import { Icon } from './icons'

export function ResourceMachineSelect({ hosts, value, onChange, label = t("机器"), disabled = false, showIcon = false }: {
  hosts: Host[]; value: string; onChange: (id: string) => void; label?: string; disabled?: boolean; showIcon?: boolean
}) {
  const select = <select className="sel" aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    {hosts.map((host) => <option value={host.id} key={host.id}>{hostDisplayName(host)}</option>)}
  </select>
  return <label className="resource-machine-field"><span>{label}</span>
    {showIcon ? <span className="settings-icon-field"><Icon name={value === 'local' ? 'laptop' : 'server'} />{select}</span> : select}
  </label>
}
