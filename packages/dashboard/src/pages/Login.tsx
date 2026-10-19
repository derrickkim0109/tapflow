import { Navigate, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getAuthStatus, queryKeys } from '@/lib/queries'
import { useTheme } from 'next-themes'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FieldError } from '@/components/ui/field-error'
import { FormErrorCount } from '@/components/ui/form-error-count'
import { PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT } from '@/lib/password'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT),
})
type FormData = z.infer<typeof schema>

export function Login() {
  const navigate = useNavigate()
  const { resolvedTheme } = useTheme()
  const defaultLogo = resolvedTheme === 'dark' ? '/logo-dark.svg' : '/logo.svg'

  // Asked once per visit (`staleTime: Infinity`): refetched on focus, a check that failed while
  // someone typed would take the form away mid-sentence. A failure keeps the form, as before.
  const status = useQuery({ queryKey: queryKeys.authStatus, queryFn: getAuthStatus, staleTime: Infinity })
  const queryClient = useQueryClient()

  const { register, handleSubmit, setError, formState: { errors, isSubmitting, submitCount } } = useForm<FormData>({
    shouldFocusError: false, // FormErrorCount focuses, once the field is described (#824)
    resolver: zodResolver(schema),
  })

  async function onSubmit(data: FormData) {
    try {
      const { status } = await api.post('/api/v1/auth/login', { email: data.email, password: data.password })
      if (status !== 200) { setError('root', { message: 'Invalid email or password' }); return }
      // Everything cached belongs to whoever was signed in before — and the cached user may be the
      // "nobody" that sent this person here, which the layout would read on arrival and bounce them
      // back to sign in. Sign-out clears the cache too; a session that expired never signed out.
      queryClient.clear()
      navigate('/app-center', { replace: true })
    } catch {
      setError('root', { message: 'Network error. Please try again.' })
    }
  }

  if (status.data?.initialized === false) return <Navigate to="/setup" replace />

  return (
    <div className="flex min-h-svh items-center justify-center overflow-hidden p-4">
      <div className="flex flex-col items-center gap-6 w-full max-w-sm">
        <div className="flex items-center gap-2">
          <img src={defaultLogo} alt="tapflow" className="w-6 h-6" />
          <span className="text-base font-semibold tracking-tight">tapflow</span>
        </div>
        <Card level={4} className="w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl tracking-display-md">Welcome back</CardTitle>
          <CardDescription>Sign in to your team workspace</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@company.com"
                autoComplete="email"
                aria-required="true"
                aria-invalid={!!errors.email}
                aria-describedby={errors.email ? 'email-error' : undefined}
                {...register('email')}
              />
              <FieldError id="email-error" message={errors.email?.message} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                aria-required="true"
                aria-invalid={!!errors.password}
                aria-describedby={errors.password ? 'password-error' : undefined}
                {...register('password')}
              />
              <FieldError id="password-error" message={errors.password?.message} />
            </div>
            <FieldError assertive id="login-error" message={errors.root?.message} />
            <Button type="submit" size="lg" disabled={isSubmitting} className="w-full mt-1">
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
            <FormErrorCount errors={errors} submitCount={submitCount} />
          </form>
        </CardContent>
        </Card>
      </div>
    </div>
  )
}
