/** Platform observations are a read model; collecting them remains a server capability. */
export type MetricValues = Record<'views' | 'likes' | 'comments' | 'shares' | 'favorites' | 'clicks', number | null>;
