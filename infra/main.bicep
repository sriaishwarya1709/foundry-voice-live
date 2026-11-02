targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the azd environment. Used to name the resource group and generate a unique suffix.')
param environmentName string

@description('Region for all resources. Must support Voice Live (and avatar, if you want to use it).')
@allowed([
  'swedencentral'
  'westeurope'
  'northeurope'
  'eastus2'
  'westus2'
  'southcentralus'
  'southeastasia'
  'centralindia'
])
param location string = 'swedencentral'

@description('Object ID of the user/service principal running the deployment. azd fills this in automatically.')
param principalId string = ''

@allowed(['User', 'ServicePrincipal'])
param principalType string = 'User'

@description('Chat model the Foundry prompt agent uses. Voice Live handles speech in/out around it.')
param modelName string = 'gpt-4.1'

param modelVersion string = '2025-04-14'

@description('Model deployment capacity in thousands of tokens per minute.')
param modelCapacity int = 50

@description('Name of the Foundry prompt agent created by the post-provision hook.')
param agentName string = 'voice-live-agent'

@description('Deploy the demo web app to Azure Container Apps.')
param deployWebApp bool = true

@secure()
@description('Optional access code required to open a voice session in the hosted web app. Leave empty to disable.')
param demoAccessCode string = ''

var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var tags = { 'azd-env-name': environmentName }

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module resources 'resources.bicep' = {
  name: 'resources'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceToken: resourceToken
    principalId: principalId
    principalType: principalType
    modelName: modelName
    modelVersion: modelVersion
    modelCapacity: modelCapacity
    agentName: agentName
    deployWebApp: deployWebApp
    demoAccessCode: demoAccessCode
  }
}

output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_VOICELIVE_ENDPOINT string = resources.outputs.voiceLiveEndpoint
output FOUNDRY_ACCOUNT_NAME string = resources.outputs.accountName
output FOUNDRY_PROJECT_NAME string = resources.outputs.projectName
output FOUNDRY_PROJECT_ENDPOINT string = resources.outputs.projectEndpoint
output MODEL_DEPLOYMENT_NAME string = resources.outputs.modelDeploymentName
output AGENT_NAME string = agentName
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.registryEndpoint
output WEB_URL string = resources.outputs.webUrl
