import type { Host } from '../shared/types'
import { HOST_COLORS, hostColor } from '../shared/host-colors'
import { Icon } from './icons'

export function HostColorPicker({ value, hosts, id, onChange }: { value: string; hosts: Host[]; id?: string; onChange: (color: string) => void }) {
  const duplicate = hosts.filter((host) => host.id !== id && hostColor(host.color) === value)
  return <div className="fld host-color-picker"><span id={`host-color-${id || 'new'}`}>环境颜色</span>
    <div className="host-color-options" role="group" aria-labelledby={`host-color-${id || 'new'}`}>
      {HOST_COLORS.map((color) => <button type="button" key={color.id} className="host-color-option" data-color={color.id} aria-label={color.name} aria-pressed={color.id === value} title={color.name} onClick={() => onChange(color.id)}><Icon name="folder" />{color.id === value ? <Icon name="check" className="s" /> : null}</button>)}
    </div>
    <small>{duplicate.length ? `该颜色已被 ${duplicate.map((host) => host.name).join('、')} 使用，建议选择其他颜色以便区分机器。` : '项目的文件夹使用此颜色，建议每个环境选择不同颜色。'}</small>
  </div>
}
