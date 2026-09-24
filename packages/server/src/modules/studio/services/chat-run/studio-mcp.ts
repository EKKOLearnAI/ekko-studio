import { readConfigYamlForProfile } from '../../public/profile-config'
import { studioMcpCapabilities } from '../../public/runs/mcp-capabilities'

export async function hermesStudioMcpCapabilities(profile: string) {
  const config = await readConfigYamlForProfile(profile)
  return studioMcpCapabilities(config.mcp_servers)
}
