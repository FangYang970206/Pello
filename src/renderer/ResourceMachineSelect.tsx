import { t } from '../shared/i18n'
import { hostDisplayName, type Host } from '../shared/types'

export function ResourceMachineSelect({ hosts, value, onChange, label = t("机器"), disabled = false }: {
  hosts: Host[]; value: string; onChange: (id: string) => void; label?: string; disabled?: boolean
}) {
  return <label className="resource-machine-field"><span>{label}</span>
    <select className="sel" aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {hosts.map((host) => <option value={host.id} key={host.id}>{hostDisplayName(host)}</option>)}
    </select>
  </label>
}
