export type Endpoint = { id: string; name: string; created_at: string };

export type CapturedRequest = {
  id: string;
  method: string;
  content_type: string;
  source_ip: string;
  received_at: string;
};

export type RequestDetail = {
  id: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  query_params: Record<string, string>;
  source_ip: string;
  content_type: string;
  received_at: string;
};

export type ReplayResult = {
  status_code: string;
  response_body: string;
  duration_ms: string;
  error: string | null;
};

export type DeliveryAttempt = {
  id: string;
  destination_url: string;
  status_code: string | null;
  duration_ms: string | null;
  error: string | null;
  attempted_at: string;
};

export type DeleteTarget = { type: "endpoint" | "request"; id: string };
