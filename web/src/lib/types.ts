// Shapes returned by the Heterotopia contract (all amounts are yoctoNEAR strings).
export interface Tier {
  name: string
  price: string
  max_supply: number
  minted: number
  weight: number
  acc_per_nft: string
}

export interface Allocation {
  holders_bps: number
  agent_bps: number
  ops_bps: number
  role_bps: number
}

export interface Agent {
  account_id: string
  name: string
  per_tx_cap: string
  daily_cap: string
  payees: string[]
  active: boolean
  hired_by: string
  probation_until: number
  day: number
  spent_today: string
  model: string
  instructions: string
  swarm_role: string
}

export interface Startup {
  id: number
  name: string
  description: string
  founder: string
  treasury: string
  tiers: Tier[]
  allocation: Allocation
  raised: string
  revenue: string
  agent_balance: string
  ops_balance: string
  role_acc: string
  total_role_weight: number
  agents: Agent[]
  results_private: boolean
  status: string
}

export interface Job {
  id: number
  startup_id: number
  customer: string
  description: string
  amount: string
  created_at_ms: number
  deadline_ms: number
  review_ms: number
  status: string
  agent: string | null
  delivered_at_ms: number
  dispute_reason: string | null
  private: boolean
}
